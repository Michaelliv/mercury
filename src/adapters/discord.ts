/**
 * Discord adapter integration layer.
 *
 * The low-level Discord API is handled by @chat-adapter/discord (DiscordAdapter).
 * This module provides the mercury-specific glue:
 *   - Channel → group mapping (groupId = "discord:<channelId>")
 *   - Trigger matching + routing through the core runtime
 *   - Ambient message capture for non-triggered messages
 *   - DM detection via @me guild convention
 */

import {
  createDiscordAdapter as createBaseDiscordAdapter,
  type DiscordAdapter,
  type DiscordThreadId,
} from "@chat-adapter/discord";
import type { Message, Thread } from "chat";
import type { AppConfig } from "../config.js";
import type { MercuryCoreRuntime } from "../core/runtime.js";
import { loadTriggerConfig, matchTrigger } from "../core/trigger.js";
import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { IngressMessage } from "../types.js";

/**
 * Determine if a Discord thread is a DM.
 * DMs have guildId === "@me".
 */
export function isDiscordDM(threadId: string): boolean {
  const parts = threadId.split(":");
  return parts.length >= 2 && parts[0] === "discord" && parts[1] === "@me";
}

/**
 * Build a platform-qualified caller ID from a Discord message.
 */
export function discordCallerId(message: Message): string {
  const userId = message.author.userId || "unknown";
  return `discord:${userId}`;
}

export interface DiscordMessageHandlerOptions {
  core: MercuryCoreRuntime;
  db: Db;
  config: AppConfig;
}

/**
 * Create the message handler for Discord threads.
 *
 * Returns a function with the same signature as the generic handler in chat-sdk.ts,
 * but with Discord-specific group mapping and ambient capture logic.
 *
 * The handler does a cheap pre-route trigger check so it can fire the typing
 * indicator *before* the expensive handleRawInput call (which includes the
 * full container run). This matches the WhatsApp handler's UX behavior.
 */
export function createDiscordMessageHandler(
  opts: DiscordMessageHandlerOptions,
) {
  const { core, db, config } = opts;

  // Get bot user ID from adapter for mention conversion
  const getBotUserId = (adapter: unknown): string | undefined => {
    return (adapter as { botUserId?: string }).botUserId;
  };

  return async (
    thread: Thread,
    message: Message,
    isNew: boolean,
  ): Promise<void> => {
    if (message.author.isMe) return;

    let text = message.text.trim();
    if (!text) return;

    // Convert Discord raw mentions <@botId> to @userName for trigger matching
    const botUserId = getBotUserId(thread.adapter);
    if (botUserId) {
      text = text.replace(
        new RegExp(`<@!?${botUserId}>`, "g"),
        `@${config.chatSdkUserName}`,
      );
    }

    const groupId = thread.id;
    const callerId = discordCallerId(message);
    const isDM = isDiscordDM(thread.id);

    // Extract reply flag from message metadata (set by discord-native adapter)
    const isReplyToBot =
      (message.metadata as { isReplyToBot?: boolean })?.isReplyToBot ?? false;

    logger.debug("Discord inbound", {
      groupId,
      callerId,
      isDM,
      isReplyToBot,
      threadId: thread.id,
      preview: text.slice(0, 120),
    });

    try {
      // Pre-route trigger check: fire typing indicator early (before the
      // potentially slow handleRawInput which queues a container run).
      const defaultPatterns = config.triggerPatterns
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const triggerConfig = loadTriggerConfig(db, groupId, {
        patterns: defaultPatterns,
        match: config.triggerMatch,
      });
      const triggerResult = matchTrigger(text, triggerConfig, isDM);

      // Start typing if trigger matched or reply to bot
      const shouldStartTyping =
        triggerResult.matched || (isReplyToBot && !isDM);
      if (shouldStartTyping) {
        if (isNew) await thread.subscribe();
        await thread.startTyping();
      }

      // Construct IngressMessage for the new handleRawInput signature
      const ingress: IngressMessage = {
        platform: "discord",
        groupId,
        callerId,
        authorName: message.author.userName,
        text, // Use converted text with @userName
        isDM,
        isReplyToBot,
        attachments: [],
      };

      const result = await core.handleRawInput(ingress, "chat-sdk");

      if (result.type === "ignore") return;

      const replyText =
        result.type === "denied" ? result.reason : result.result?.reply;
      if (replyText) {
        logger.info("Discord reply", {
          groupId,
          preview: replyText.slice(0, 120),
        });
        await thread.post(replyText);
      }
    } catch (err) {
      logger.error("Discord handler error", {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export type { DiscordAdapter, DiscordThreadId };

/**
 * Create a configured Discord adapter instance.
 * Reads from standard Discord environment variables.
 */
export function createDiscordAdapter(options?: {
  userName?: string;
}): DiscordAdapter {
  const botToken = process.env.MERCURY_DISCORD_BOT_TOKEN;
  const publicKey = process.env.MERCURY_DISCORD_PUBLIC_KEY;
  const applicationId = process.env.MERCURY_DISCORD_APPLICATION_ID;

  if (!botToken || !publicKey || !applicationId) {
    throw new Error(
      "Discord adapter requires MERCURY_DISCORD_BOT_TOKEN, MERCURY_DISCORD_PUBLIC_KEY, and MERCURY_DISCORD_APPLICATION_ID",
    );
  }

  logger.info("Creating Discord adapter", { applicationId });

  return createBaseDiscordAdapter({
    botToken,
    publicKey,
    applicationId,
    userName: options?.userName,
  });
}
