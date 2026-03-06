/**
 * Slack adapter integration layer.
 *
 * The low-level Slack API is handled by @chat-adapter/slack (SlackAdapter).
 * This module provides the mercury-specific glue:
 *   - Channel → group mapping (groupId = "slack:<channelId>")
 *   - Trigger matching + routing through the core runtime
 *   - Ambient message capture for non-triggered messages
 *   - DM detection via Slack channel type conventions
 */

import type { Message, Thread } from "chat";
import type { AppConfig } from "../config.js";
import type { MercuryCoreRuntime } from "../core/runtime.js";
import { loadTriggerConfig, matchTrigger } from "../core/trigger.js";
import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { IngressMessage } from "../types.js";

/**
 * Derive the mercury group ID from a Slack thread.
 *
 * Slack thread IDs are encoded as "slack:<channel>:<threadTs>".
 * We group by channel, so the group ID is "slack:<channel>".
 */
export function slackGroupId(threadId: string): string {
  const parts = threadId.split(":");
  if (parts.length >= 2 && parts[0] === "slack") {
    return `slack:${parts[1]}`;
  }
  // Fallback — use the full thread ID
  return threadId;
}

/**
 * Determine if a Slack thread is a DM.
 *
 * Slack DM channel IDs start with "D".
 * Slack group DMs (MPDMs) start with "G" — these are treated as DMs too,
 * so the bot responds without requiring a trigger (same as 1:1 DMs).
 */
export function isSlackDM(threadId: string): boolean {
  const parts = threadId.split(":");
  if (parts.length >= 2 && parts[0] === "slack") {
    const ch = parts[1];
    return ch.startsWith("D") || ch.startsWith("G");
  }
  return false;
}

/**
 * Build a platform-qualified caller ID from a Slack message.
 */
export function slackCallerId(message: Message): string {
  const userId = message.author.userId || "unknown";
  return `slack:${userId}`;
}

export interface SlackMessageHandlerOptions {
  core: MercuryCoreRuntime;
  db: Db;
  config: AppConfig;
}

/**
 * Create the message handler for Slack threads.
 *
 * Returns a function with the same signature as the WhatsApp handler in chat-sdk.ts,
 * but with Slack-specific group mapping and ambient capture logic.
 *
 * The handler does a cheap pre-route trigger check so it can fire the typing
 * indicator *before* the expensive handleRawInput call (which includes the
 * full container run). This matches the WhatsApp handler's UX behavior.
 */
export function createSlackMessageHandler(opts: SlackMessageHandlerOptions) {
  const { core, db, config } = opts;

  return async (
    thread: Thread,
    message: Message,
    isNew: boolean,
  ): Promise<void> => {
    if (message.author.isMe) return;

    const text = message.text.trim();
    if (!text) return;

    const groupId = slackGroupId(thread.id);
    const callerId = slackCallerId(message);
    const isDM = isSlackDM(thread.id);

    // Slack reply-to-bot detection is not implemented.
    // Slack's threading model is different — users typically @ mention in threads.
    // For thread participation detection, would need to fetch thread history.
    // TODO: Implement basic parent-message check if needed.
    const isReplyToBot = false;

    logger.debug("Slack inbound", {
      groupId,
      callerId,
      isDM,
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

      if (triggerResult.matched) {
        if (isNew) await thread.subscribe();
        await thread.startTyping();
      }

      // Construct IngressMessage for the new handleRawInput signature
      const ingress: IngressMessage = {
        platform: "slack",
        groupId,
        callerId,
        authorName: message.author.userName,
        text: message.text,
        isDM,
        isReplyToBot,
        attachments: [],
      };

      const result = await core.handleRawInput(ingress, "chat-sdk");

      if (result.type === "ignore") return;

      const replyText =
        result.type === "denied" ? result.reason : result.result?.reply;
      if (replyText) {
        logger.info("Slack reply", {
          groupId,
          preview: replyText.slice(0, 120),
        });
        await thread.post(replyText);
      }
    } catch (err) {
      logger.error("Slack handler error", {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
