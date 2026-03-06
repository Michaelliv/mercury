import path from "node:path";
import type { Message } from "chat";
import type { DiscordNativeAdapter } from "../adapters/discord-native.js";
import { downloadMediaFromUrl, mimeToMediaType } from "../core/media.js";
import { logger } from "../logger.js";
import type {
  EgressFile,
  IngressMessage,
  MessageAttachment,
  NormalizeContext,
  PlatformBridge,
} from "../types.js";

export class DiscordBridge implements PlatformBridge {
  readonly platform = "discord";

  constructor(private readonly adapter: DiscordNativeAdapter) {}

  groupId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    const parts = threadId.split(":");
    return parts.length >= 2 && parts[0] === "discord" && parts[1] === "@me";
  }

  async normalize(
    threadId: string,
    message: unknown,
    ctx: NormalizeContext,
  ): Promise<IngressMessage | null> {
    const msg = message as Message;
    if (msg.author.isMe) return null;

    let text = msg.text.trim();
    const rawAttachments = msg.attachments ?? [];
    if (!text && rawAttachments.length === 0) return null;

    const botUserId = this.adapter.botUserId;
    if (botUserId) {
      text = text.replace(
        new RegExp(`<@!?${botUserId}>`, "g"),
        `@${ctx.botUserName}`,
      );
    }

    const isReplyToBot =
      (msg.metadata as { isReplyToBot?: boolean })?.isReplyToBot ?? false;

    const attachments: MessageAttachment[] = [];
    if (ctx.media.enabled && rawAttachments.length > 0) {
      const workspace = ctx.getWorkspace(this.groupId(threadId));
      if (workspace) {
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
    }

    return {
      platform: "discord",
      groupId: this.groupId(threadId),
      callerId: `discord:${msg.author.userId || "unknown"}`,
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
    const client = this.adapter.discordClient;
    const { channelId, threadId: discordThreadId } =
      this.adapter.decodeThreadId(threadId);
    const targetId = discordThreadId || channelId;

    try {
      const channel = await client.channels.fetch(targetId);
      if (!channel || !("send" in channel)) {
        logger.warn("Discord channel not sendable, falling back to text-only", {
          targetId,
        });
        if (text) await this.adapter.postMessage(threadId, text);
        return;
      }

      const discordFiles = files.map((f) => ({
        attachment: f.path,
        name: f.filename,
      }));

      await (channel as { send: (opts: unknown) => Promise<unknown> }).send({
        content: text || undefined,
        files: discordFiles,
      });
    } catch (err) {
      logger.error("Failed to send files via Discord", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (text) await this.adapter.postMessage(threadId, text);
    }
  }
}
