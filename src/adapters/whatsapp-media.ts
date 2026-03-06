/**
 * WhatsApp media download and processing.
 *
 * Downloads media attachments from WhatsApp messages and saves them to
 * the group workspace. Implements generic MediaType classification that
 * can be reused by other adapters.
 */

import fs from "node:fs";
import path from "node:path";
import {
  downloadMediaMessage,
  type proto,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { mimeToExt } from "../core/media.js";
import { logger } from "../logger.js";
import type { MediaType, MessageAttachment } from "../types.js";

/**
 * Media info extracted from a WhatsApp message.
 * Used internally before download.
 */
interface WhatsAppMediaInfo {
  type: MediaType;
  mimeType: string;
  fileLength?: number;
  filename?: string;
}

/**
 * Options for media download.
 */
export interface MediaDownloadOptions {
  /** Maximum file size in bytes. Files larger than this are skipped. */
  maxSizeBytes: number;
  /** Base directory for media storage (group workspace) */
  outputDir: string;
}

/**
 * Detect media type and extract metadata from a WhatsApp message.
 * Returns null if the message has no media.
 */
export function detectWhatsAppMedia(
  message: proto.IMessage | null | undefined,
): WhatsAppMediaInfo | null {
  if (!message) return null;

  // Voice note (push-to-talk)
  if (message.audioMessage?.ptt) {
    return {
      type: "voice",
      mimeType: message.audioMessage.mimetype || "audio/ogg",
      fileLength: message.audioMessage.fileLength
        ? Number(message.audioMessage.fileLength)
        : undefined,
    };
  }

  // Regular audio
  if (message.audioMessage) {
    return {
      type: "audio",
      mimeType: message.audioMessage.mimetype || "audio/mpeg",
      fileLength: message.audioMessage.fileLength
        ? Number(message.audioMessage.fileLength)
        : undefined,
    };
  }

  // Image
  if (message.imageMessage) {
    return {
      type: "image",
      mimeType: message.imageMessage.mimetype || "image/jpeg",
      fileLength: message.imageMessage.fileLength
        ? Number(message.imageMessage.fileLength)
        : undefined,
    };
  }

  // Video
  if (message.videoMessage) {
    return {
      type: "video",
      mimeType: message.videoMessage.mimetype || "video/mp4",
      fileLength: message.videoMessage.fileLength
        ? Number(message.videoMessage.fileLength)
        : undefined,
    };
  }

  // Document
  if (message.documentMessage) {
    return {
      type: "document",
      mimeType: message.documentMessage.mimetype || "application/octet-stream",
      fileLength: message.documentMessage.fileLength
        ? Number(message.documentMessage.fileLength)
        : undefined,
      filename: message.documentMessage.fileName || undefined,
    };
  }

  // Sticker (treat as image)
  if (message.stickerMessage) {
    return {
      type: "image",
      mimeType: message.stickerMessage.mimetype || "image/webp",
      fileLength: message.stickerMessage.fileLength
        ? Number(message.stickerMessage.fileLength)
        : undefined,
    };
  }

  return null;
}

/**
 * Download media from a WhatsApp message and save to the group workspace.
 *
 * @param msg - The WhatsApp message containing media
 * @param sock - The WhatsApp socket connection
 * @param options - Download options (max size, output directory)
 * @returns Attachment metadata if successful, null if skipped or failed
 */
export async function downloadWhatsAppMedia(
  msg: WAMessage,
  sock: WASocket,
  options: MediaDownloadOptions,
): Promise<MessageAttachment | null> {
  const mediaInfo = detectWhatsAppMedia(msg.message);
  if (!mediaInfo) return null;

  const messageId = msg.key.id || `${Date.now()}`;

  // Check file size before downloading
  if (mediaInfo.fileLength && mediaInfo.fileLength > options.maxSizeBytes) {
    logger.warn("Skipping large media file", {
      messageId,
      type: mediaInfo.type,
      sizeBytes: mediaInfo.fileLength,
      maxBytes: options.maxSizeBytes,
    });
    return null;
  }

  try {
    // Create a silent logger for Baileys (satisfies ILogger interface)
    const silentLogger: {
      level: string;
      child: () => typeof silentLogger;
      trace: () => void;
      debug: () => void;
      info: () => void;
      warn: () => void;
      error: () => void;
      fatal: () => void;
    } = {
      level: "silent",
      child: () => silentLogger,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    };

    // Download the media
    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        // biome-ignore lint/suspicious/noExplicitAny: Baileys logger type is complex
        logger: silentLogger as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error("Failed to download media: empty buffer", { messageId });
      return null;
    }

    // Check actual size after download (in case fileLength was missing)
    if (buffer.length > options.maxSizeBytes) {
      logger.warn("Downloaded media exceeds size limit, discarding", {
        messageId,
        type: mediaInfo.type,
        sizeBytes: buffer.length,
        maxBytes: options.maxSizeBytes,
      });
      return null;
    }

    // Ensure inbox directory exists
    const mediaDir = path.join(options.outputDir, "inbox");
    fs.mkdirSync(mediaDir, { recursive: true });

    // Generate filename: {timestamp}-{type}.{ext}
    const ext = mimeToExt(mediaInfo.mimeType);
    const filename = mediaInfo.filename
      ? `${Date.now()}-${mediaInfo.filename}`
      : `${Date.now()}-${mediaInfo.type}.${ext}`;

    const filePath = path.join(mediaDir, filename);

    // Write file
    fs.writeFileSync(filePath, buffer);

    logger.info("Downloaded media", {
      messageId,
      type: mediaInfo.type,
      mimeType: mediaInfo.mimeType,
      sizeBytes: buffer.length,
      path: filePath,
    });

    return {
      path: filePath,
      type: mediaInfo.type,
      mimeType: mediaInfo.mimeType,
      filename: mediaInfo.filename,
      sizeBytes: buffer.length,
    };
  } catch (error) {
    logger.error("Failed to download media", {
      messageId,
      type: mediaInfo.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
