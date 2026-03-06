/**
 * Shared media utilities for ingress/egress pipeline.
 *
 * - MIME detection (filename → MIME, MIME → extension, MIME → MediaType)
 * - Generic URL-based media downloader (for Discord, Slack attachments)
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { MediaType, MessageAttachment } from "../types.js";

// ─── MIME Maps ──────────────────────────────────────────────────────────

/** Extension → MIME type */
const EXT_TO_MIME: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Audio
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  // Video
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  webm: "video/webm",
  // Documents
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  md: "text/markdown",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** MIME type → extension */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/ogg": "ogg",
  "audio/ogg; codecs=opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "text/html": "html",
  "text/markdown": "md",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

// ─── MIME Utilities ─────────────────────────────────────────────────────

/** Detect MIME type from filename extension. */
export function extToMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/** Get file extension from MIME type. Handles MIME params (e.g., "audio/ogg; codecs=opus"). */
export function mimeToExt(mimeType: string): string {
  const baseMime = mimeType.split(";")[0].trim();
  return MIME_TO_EXT[baseMime] ?? MIME_TO_EXT[mimeType] ?? "bin";
}

/** Classify MIME type into MediaType. */
export function mimeToMediaType(mimeType: string): MediaType {
  const base = mimeType.split(";")[0].trim();
  if (base.startsWith("image/")) return "image";
  if (base.startsWith("video/")) return "video";
  if (base.startsWith("audio/")) return "audio";
  return "document";
}

// ─── URL-based Media Downloader ─────────────────────────────────────────

/**
 * Download a file from a URL to a local directory.
 *
 * Used by Discord and Slack bridges to fetch attachments to workspace inbox/.
 * Returns a MessageAttachment on success, null if skipped or failed.
 */
export async function downloadMediaFromUrl(
  url: string,
  options: {
    type: MediaType;
    mimeType: string;
    filename?: string;
    expectedSizeBytes?: number;
    maxSizeBytes: number;
    outputDir: string;
    headers?: Record<string, string>;
  },
): Promise<MessageAttachment | null> {
  const { maxSizeBytes, outputDir, headers } = options;

  // Check expected size before downloading
  if (options.expectedSizeBytes && options.expectedSizeBytes > maxSizeBytes) {
    logger.warn("Skipping large media file", {
      url: url.slice(0, 100),
      type: options.type,
      sizeBytes: options.expectedSizeBytes,
      maxBytes: maxSizeBytes,
    });
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: headers ?? {},
    });

    if (!response.ok) {
      logger.error("Media download failed", {
        url: url.slice(0, 100),
        status: response.status,
      });
      return null;
    }

    // Check Content-Length header before buffering
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxSizeBytes) {
      logger.warn("Media download exceeds size limit", {
        url: url.slice(0, 100),
        sizeBytes: Number.parseInt(contentLength, 10),
        maxBytes: maxSizeBytes,
      });
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Check actual size after download
    if (buffer.length > maxSizeBytes) {
      logger.warn("Downloaded media exceeds size limit, discarding", {
        sizeBytes: buffer.length,
        maxBytes: maxSizeBytes,
      });
      return null;
    }

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Generate filename: {timestamp}-{original} or {timestamp}-{type}.{ext}
    const ext = mimeToExt(options.mimeType);
    const filename = options.filename
      ? `${Date.now()}-${options.filename}`
      : `${Date.now()}-${options.type}.${ext}`;

    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, buffer);

    logger.info("Downloaded media", {
      type: options.type,
      mimeType: options.mimeType,
      sizeBytes: buffer.length,
      path: filePath,
    });

    return {
      path: filePath,
      type: options.type,
      mimeType: options.mimeType,
      filename: options.filename,
      sizeBytes: buffer.length,
    };
  } catch (error) {
    logger.error("Failed to download media", {
      url: url.slice(0, 100),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
