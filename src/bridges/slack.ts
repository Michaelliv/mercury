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

export class SlackBridge implements PlatformBridge {
  readonly platform = "slack";

  constructor(
    private readonly adapter: Adapter,
    private readonly botToken: string,
  ) {}

  groupId(threadId: string): string {
    const parts = threadId.split(":");
    if (parts.length >= 2 && parts[0] === "slack") {
      return `slack:${parts[1]}`;
    }
    return threadId;
  }

  isDM(threadId: string): boolean {
    const parts = threadId.split(":");
    if (parts.length >= 2 && parts[0] === "slack") {
      const ch = parts[1];
      return ch.startsWith("D") || ch.startsWith("G");
    }
    return false;
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
  ): Promise<IngressMessage | null> {
    const msg = message as Message;
    if (msg.author.isMe) return null;

    const text = msg.text.trim();
    const rawAttachments = msg.attachments ?? [];
    if (!text && rawAttachments.length === 0) return null;

    const attachments: MessageAttachment[] = [];
    if (ctx.media.enabled && rawAttachments.length > 0) {
      const workspace = ctx.getWorkspace(this.groupId(threadId));
      if (workspace) {
        const inboxDir = path.join(workspace, "inbox");
        for (const att of rawAttachments) {
          const url = att.url || (att as { url_private?: string }).url_private;
          if (!url) continue;
          const type = mimeToMediaType(
            att.mimeType || "application/octet-stream",
          );
          const result = await downloadMediaFromUrl(url, {
            type,
            mimeType: att.mimeType || "application/octet-stream",
            filename: att.name,
            expectedSizeBytes: att.size,
            maxSizeBytes: ctx.media.maxSizeBytes,
            outputDir: inboxDir,
            headers: { Authorization: `Bearer ${this.botToken}` },
          });
          if (result) attachments.push(result);
        }
      }
    }

    return {
      platform: "slack",
      groupId: this.groupId(threadId),
      callerId: `slack:${msg.author.userId || "unknown"}`,
      authorName: msg.author.userName,
      text,
      isDM: this.isDM(threadId),
      isReplyToBot: false,
      attachments,
    };
  }

  async sendReply(
    threadId: string,
    text: string,
    files?: EgressFile[],
  ): Promise<void> {
    if (text) {
      await this.adapter.postMessage(threadId, text);
    }

    if (files && files.length > 0) {
      await this.uploadFiles(threadId, files);
    }
  }

  private async uploadFiles(
    threadId: string,
    files: EgressFile[],
  ): Promise<void> {
    const parts = threadId.split(":");
    const channelId = parts.length >= 2 ? parts[1] : threadId;

    for (const file of files) {
      try {
        const buffer = fs.readFileSync(file.path);
        const form = new FormData();
        form.append("channel_id", channelId);
        form.append("filename", file.filename);
        form.append(
          "file",
          new Blob([buffer], { type: file.mimeType }),
          file.filename,
        );

        const resp = await fetch("https://slack.com/api/files.uploadV2", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.botToken}` },
          body: form,
        });

        if (!resp.ok) {
          logger.error("Slack file upload HTTP error", {
            filename: file.filename,
            status: resp.status,
          });
        } else {
          const body = (await resp.json()) as { ok?: boolean; error?: string };
          if (!body.ok) {
            logger.error("Slack file upload API error", {
              filename: file.filename,
              error: body.error,
            });
          }
        }
      } catch (err) {
        logger.error("Slack file upload failed", {
          filename: file.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
