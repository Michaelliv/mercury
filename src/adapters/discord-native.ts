/**
 * Native Discord adapter using discord.js for persistent WebSocket connection.
 *
 * Similar to the WhatsApp/Baileys adapter pattern — maintains a persistent
 * connection instead of the serverless gateway approach.
 */

import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  parseMarkdown,
  type RawMessage,
  stringifyMarkdown,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import {
  Client,
  type Message as DiscordMessage,
  Events,
  GatewayIntentBits,
  type OmitPartialGroupDMChannel,
  Partials,
} from "discord.js";
import { logger } from "../logger.js";

/** Discord's maximum message length */
export const DISCORD_MAX_LENGTH = 2000;

/**
 * Split a message into chunks that fit within Discord's character limit.
 * Tries to break at natural boundaries (paragraphs, lines, spaces) when possible.
 */
export function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to break at paragraph boundary
    let breakPoint = remaining.lastIndexOf("\n\n", maxLength);

    // Fall back to line break
    if (breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf("\n", maxLength);
    }

    // Fall back to space
    if (breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(" ", maxLength);
    }

    // Hard break if no good boundary found
    if (breakPoint <= 0) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint).trim());
    remaining = remaining.slice(breakPoint).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

type DiscordThreadId = {
  guildId: string;
  channelId: string;
  threadId?: string;
};

export interface DiscordNativeAdapterOptions {
  /** Bot token */
  botToken: string;
  /** Bot username for trigger matching */
  userName?: string;
}

export class DiscordNativeAdapter
  implements Adapter<DiscordThreadId, DiscordMessage>
{
  readonly name = "discord";
  readonly userName: string;

  private chat?: ChatInstance;
  private client: Client;
  private readonly botToken: string;

  constructor(options: DiscordNativeAdapterOptions) {
    this.userName = options.userName ?? "mercury";
    this.botToken = options.botToken;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  get botUserId(): string | undefined {
    return this.client.user?.id;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    logger.info("Discord native adapter initializing");

    this.client.on(Events.ClientReady, () => {
      logger.info("Discord native adapter connected", {
        username: this.client.user?.username,
        id: this.client.user?.id,
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleIncomingMessage(message);
    });

    this.client.on(Events.Error, (error) => {
      logger.error("Discord client error", { error: error.message });
    });

    await this.client.login(this.botToken);
  }

  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions,
  ): Promise<Response> {
    // No webhook needed — we use persistent WebSocket
    return new Response("Discord native adapter uses WebSocket, no webhook.", {
      status: 202,
    });
  }

  encodeThreadId(platformData: DiscordThreadId): string {
    const parts = ["discord", platformData.guildId, platformData.channelId];
    if (platformData.threadId) {
      parts.push(platformData.threadId);
    }
    return parts.join(":");
  }

  decodeThreadId(threadId: string): DiscordThreadId {
    const parts = threadId.split(":");
    if (parts.length < 3 || parts[0] !== "discord") {
      throw new Error(`Invalid Discord thread ID: ${threadId}`);
    }
    return {
      guildId: parts[1],
      channelId: parts[2],
      threadId: parts[3],
    };
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<DiscordMessage>> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("send" in channel)) {
      throw new Error(`Cannot send to channel: ${targetId}`);
    }

    const text = this.postableToText(message);
    const chunks = chunkMessage(text, DISCORD_MAX_LENGTH);

    let lastSent: DiscordMessage | undefined;
    for (const chunk of chunks) {
      lastSent = await channel.send(chunk);
    }

    // lastSent is guaranteed to be defined since chunks always has at least one element
    const sent = lastSent as DiscordMessage;
    return {
      id: sent.id,
      threadId,
      raw: sent,
    };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<DiscordMessage>> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("messages" in channel)) {
      throw new Error(`Cannot edit in channel: ${targetId}`);
    }

    const msg = await channel.messages.fetch(messageId);
    const text = this.postableToText(message);
    const edited = await msg.edit(text);

    return {
      id: edited.id,
      threadId,
      raw: edited,
    };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("messages" in channel)) {
      throw new Error(`Cannot delete in channel: ${targetId}`);
    }

    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("messages" in channel)) {
      throw new Error(`Cannot react in channel: ${targetId}`);
    }

    const msg = await channel.messages.fetch(messageId);
    const emojiStr = typeof emoji === "string" ? emoji : emoji.toString();
    await msg.react(emojiStr);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("messages" in channel)) {
      throw new Error(`Cannot remove reaction in channel: ${targetId}`);
    }

    const msg = await channel.messages.fetch(messageId);
    const emojiStr = typeof emoji === "string" ? emoji : emoji.toString();
    const reaction = msg.reactions.cache.find(
      (r) => r.emoji.name === emojiStr || r.emoji.toString() === emojiStr,
    );
    if (reaction) {
      await reaction.users.remove(this.client.user?.id);
    }
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<DiscordMessage>> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (!channel || !("messages" in channel)) {
      return { messages: [] };
    }

    const fetchOptions: { limit?: number; before?: string } = {};
    if (options?.limit) fetchOptions.limit = options.limit;
    if (options?.cursor) fetchOptions.before = options.cursor;

    const messages = await channel.messages.fetch(fetchOptions);
    const parsed = messages.map((msg) => this.parseMessage(msg));

    return { messages: Array.from(parsed.values()) };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const {
      guildId,
      channelId,
      threadId: discordThreadId,
    } = this.decodeThreadId(threadId);

    const isDM = guildId === "@me";

    return {
      id: threadId,
      channelId: `discord:${guildId}:${channelId}`,
      isDM,
      metadata: { guildId, channelId, threadId: discordThreadId },
    };
  }

  parseMessage(raw: DiscordMessage): Message<DiscordMessage> {
    const guildId = raw.guildId || "@me";
    const channelId = raw.channelId;
    const threadId = raw.thread?.id;

    const fullThreadId = this.encodeThreadId({ guildId, channelId, threadId });

    // Check if bot is mentioned
    const isMention =
      raw.mentions.users.has(this.client.user?.id || "") ||
      raw.mentions.everyone ||
      raw.content.includes(`<@${this.client.user?.id}>`);

    return new Message({
      id: raw.id,
      threadId: fullThreadId,
      text: raw.content,
      formatted: parseMarkdown(raw.content),
      raw,
      isMention,
      author: {
        userId: raw.author.id,
        userName: raw.author.username,
        fullName: raw.author.displayName || raw.author.username,
        isBot: raw.author.bot,
        isMe: raw.author.id === this.client.user?.id,
      },
      metadata: {
        dateSent: raw.createdAt,
        edited: raw.editedAt !== null,
      },
      attachments: raw.attachments.map((a) => ({
        type: this.getAttachmentType(a.contentType),
        url: a.url,
        name: a.name,
        size: a.size,
        mimeType: a.contentType || undefined,
      })),
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async startTyping(threadId: string): Promise<void> {
    const { channelId, threadId: discordThreadId } =
      this.decodeThreadId(threadId);

    const targetId = discordThreadId || channelId;
    const channel = await this.client.channels.fetch(targetId);

    if (channel && "sendTyping" in channel) {
      await channel.sendTyping();
    }
  }

  async shutdown(): Promise<void> {
    await this.client.destroy();
    logger.info("Discord native adapter disconnected");
  }

  /**
   * Handle incoming Discord message.
   */
  private async handleIncomingMessage(
    msg: OmitPartialGroupDMChannel<DiscordMessage>,
  ): Promise<void> {
    // Ignore bot messages
    if (msg.author.bot) return;
    if (msg.author.id === this.client.user?.id) return;

    // Ignore empty messages
    if (!msg.content && msg.attachments.size === 0) return;

    const guildId = msg.guildId || "@me";
    const channelId = msg.channelId;
    const threadId = msg.thread?.id;

    const fullThreadId = this.encodeThreadId({ guildId, channelId, threadId });

    // Convert mentions for trigger matching
    let text = msg.content;
    if (this.client.user?.id) {
      text = text.replace(
        new RegExp(`<@!?${this.client.user.id}>`, "g"),
        `@${this.userName}`,
      );
    }

    const isDM = guildId === "@me";
    const isMention =
      msg.mentions.users.has(this.client.user?.id || "") ||
      msg.content.includes(`<@${this.client.user?.id}>`);

    // Check if this is a reply to one of our messages
    let isReplyToBot = false;
    if (msg.reference?.messageId && this.client.user?.id) {
      try {
        const channel = msg.channel;
        if ("messages" in channel) {
          const repliedTo = await channel.messages.fetch(
            msg.reference.messageId,
          );
          isReplyToBot = repliedTo.author.id === this.client.user.id;
        }
      } catch {
        // Referenced message may be deleted or inaccessible
      }
    }

    logger.debug("Discord native inbound", {
      guildId,
      channelId,
      threadId,
      isDM,
      isMention,
      isReplyToBot,
      preview: text.slice(0, 80),
    });

    const incoming = new Message<DiscordMessage>({
      id: msg.id,
      threadId: fullThreadId,
      text,
      formatted: parseMarkdown(text),
      raw: msg as DiscordMessage,
      isMention: isMention || isDM,
      author: {
        userId: msg.author.id,
        userName: msg.author.username,
        fullName: msg.author.displayName || msg.author.username,
        isBot: msg.author.bot,
        isMe: false,
      },
      metadata: {
        dateSent: msg.createdAt,
        edited: msg.editedAt !== null,
        // Store reply flag in metadata for downstream consumers
        ...({ isReplyToBot } as Record<string, unknown>),
      },
      attachments: msg.attachments.map((a) => ({
        type: this.getAttachmentType(a.contentType),
        url: a.url,
        name: a.name,
        size: a.size,
        mimeType: a.contentType || undefined,
      })),
    });

    this.chat?.processMessage(this, fullThreadId, incoming);
  }

  private postableToText(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if (typeof message === "object" && message !== null) {
      if ("markdown" in message && typeof message.markdown === "string")
        return message.markdown;
      if ("ast" in message && message.ast)
        return stringifyMarkdown(message.ast);
      if ("raw" in message && typeof message.raw === "string")
        return message.raw;
    }
    return "";
  }

  private getAttachmentType(
    mimeType: string | null,
  ): "image" | "video" | "audio" | "file" {
    if (!mimeType) return "file";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
  }
}

export function createDiscordNativeAdapter(
  options?: Partial<DiscordNativeAdapterOptions>,
): DiscordNativeAdapter {
  const botToken = options?.botToken || process.env.DISCORD_BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      "Discord native adapter requires DISCORD_BOT_TOKEN environment variable",
    );
  }

  return new DiscordNativeAdapter({
    botToken,
    userName: options?.userName,
  });
}
