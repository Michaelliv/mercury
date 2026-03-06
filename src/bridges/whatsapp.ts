import fs from "node:fs";
import type { Message } from "chat";
import type { WhatsAppBaileysAdapter } from "../adapters/whatsapp.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class WhatsAppBridge implements PlatformBridge {
  readonly platform = "whatsapp";

  constructor(private readonly adapter: WhatsAppBaileysAdapter) {}

  groupId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return !threadId.includes("@g.us");
  }

  async normalize(
    threadId: string,
    message: unknown,
    _ctx: NormalizeContext,
  ): Promise<IngressMessage | null> {
    const msg = message as Message;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const metadata = msg.metadata as {
      attachments?: MessageAttachment[];
      isReplyToBot?: boolean;
    };
    const attachments = Array.isArray(metadata?.attachments)
      ? metadata.attachments
      : [];
    const isReplyToBot = metadata?.isReplyToBot ?? false;

    if (!text && attachments.length === 0) return null;

    return {
      platform: "whatsapp",
      groupId: this.groupId(threadId),
      callerId: `whatsapp:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM: this.isDM(threadId),
      isReplyToBot,
      attachments,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<void> {
    if (files && files.length > 0) {
      await this.sendFiles(threadId, text, files);
    } else if (text) {
      await this.adapter.postMessage(threadId, text);
    }
  }

  private async sendFiles(
    threadId: string,
    text: string,
    files: EgressFile[],
  ): Promise<void> {
    const { chatJid } = this.adapter.decodeThreadId(threadId);
    const sock = this.adapter.socket;

    if (!sock) {
      logger.warn("WhatsApp socket unavailable, falling back to text-only");
      if (text) await this.adapter.postMessage(threadId, text);
      return;
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isLast = i === files.length - 1;
      const caption = isLast ? text : undefined;

      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(file.path);
      } catch (err) {
        logger.error("Failed to read egress file", {
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      try {
        const mime = file.mimeType;

        if (mime.startsWith("image/")) {
          await sock.sendMessage(chatJid, {
            image: buffer,
            caption,
            mimetype: mime,
          });
        } else if (mime.startsWith("video/")) {
          await sock.sendMessage(chatJid, {
            video: buffer,
            caption,
            mimetype: mime,
          });
        } else if (mime.startsWith("audio/")) {
          await sock.sendMessage(chatJid, {
            audio: buffer,
            mimetype: mime,
            ptt: false,
          });
          if (caption) {
            await sock.sendMessage(chatJid, { text: caption });
          }
        } else {
          await sock.sendMessage(chatJid, {
            document: buffer,
            fileName: file.filename,
            mimetype: mime,
            caption,
          });
        }
      } catch (err) {
        logger.error("Failed to send file via WhatsApp", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
