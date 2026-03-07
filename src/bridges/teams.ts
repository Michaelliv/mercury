import fs from "node:fs";
import path from "node:path";
import type { Adapter, Message } from "chat";
import { downloadMediaFromUrl, mimeToMediaType } from "../core/media.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class TeamsBridge implements PlatformBridge {
  readonly platform = "teams";

  constructor(private readonly adapter: Adapter) {}

  parseThread(threadId: string): { externalId: string; isDM: boolean } {
    // Teams thread IDs are "teams:<base64url-conversationId>:<base64url-serviceUrl>"
    const parts = threadId.split(":");
    const externalId = parts.slice(1).join(":");

    // Teams DMs have conversation IDs that don't start with "19:"
    // The conversationId is base64url-encoded in parts[1]
    let isDM = true;
    try {
      const conversationId = Buffer.from(parts[1] || "", "base64url").toString(
        "utf-8",
      );
      isDM = !conversationId.startsWith("19:");
    } catch {
      // If decoding fails, assume DM
    }

    return { externalId, isDM };
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
    spaceId: string,
  ): Promise<IngressMessage | null> {
    const msg = message as Message;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const rawAttachments = msg.attachments ?? [];
    if (!text && rawAttachments.length === 0) return null;

    // Download media attachments
    const attachments: MessageAttachment[] = [];
    if (ctx.media.enabled && rawAttachments.length > 0) {
      const workspace = ctx.getWorkspace(spaceId);
      const inboxDir = path.join(workspace, "inbox");
      for (const att of rawAttachments) {
        if (!att.url) continue;
        const type = mimeToMediaType(
          att.mimeType || "application/octet-stream",
        );
        const result = await downloadMediaFromUrl(att.url, {
          type,
          mimeType: att.mimeType || "application/octet-stream",
          filename: att.name,
          expectedSizeBytes: att.size,
          maxSizeBytes: ctx.media.maxSizeBytes,
          outputDir: inboxDir,
        });
        if (result) attachments.push(result);
      }
    }

    const { externalId, isDM } = this.parseThread(threadId);

    // Check reply-to-bot via raw activity
    const raw = msg.raw as { replyToId?: string } | undefined;
    const isReplyToBot = Boolean(raw?.replyToId);

    return {
      platform: "teams",
      spaceId,
      conversationExternalId: externalId,
      callerId: `teams:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM,
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
      await this.sendWithFiles(threadId, text, files);
    } else if (text) {
      await this.adapter.postMessage(threadId, text);
    }
  }

  private async sendWithFiles(
    threadId: string,
    text: string,
    files: EgressFile[],
  ): Promise<void> {
    // Build file uploads from EgressFile paths
    const fileUploads: { filename: string; mimeType: string; data: Buffer }[] =
      [];
    for (const file of files) {
      try {
        const buffer = fs.readFileSync(file.path);
        fileUploads.push({
          filename: file.filename,
          mimeType: file.mimeType,
          data: buffer,
        });
      } catch (err) {
        logger.error("Failed to read egress file", {
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Send text + files together via postMessage
    // Teams adapter extracts files from the message object and converts to inline attachments
    try {
      await this.adapter.postMessage(threadId, {
        markdown: text || "",
        files: fileUploads,
      } as never);
    } catch (err) {
      logger.error("Teams send with files failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to text-only
      if (text) {
        await this.adapter.postMessage(threadId, text);
      }
    }
  }
}
