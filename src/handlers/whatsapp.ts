import type { Message, Thread } from "chat";
import type { AppConfig } from "../config.js";
import type { MercuryCoreRuntime } from "../core/runtime.js";
import { loadTriggerConfig, matchTrigger } from "../core/trigger.js";
import type { IngressMessage } from "../types.js";

function resolveCallerId(message: Message, thread: Thread): string {
  const userId = message.author.userId || "unknown";
  const platform = thread.adapter.name;
  return `${platform}:${userId}`;
}

export function createWhatsAppMessageHandler(opts: {
  core: MercuryCoreRuntime;
  config: AppConfig;
}) {
  const { core, config } = opts;

  return async (thread: Thread, message: Message, isNew: boolean) => {
    const callerId = resolveCallerId(message, thread);

    // thread.isDM is unreliable for WhatsApp LID JIDs — derive from thread ID
    const isDM = thread.isDM || !thread.id.includes("@g.us");

    // Quick trigger check before starting typing indicator
    const text = message.text.trim();

    // Extract attachments and reply flag from message metadata (populated by adapters)
    const metadata = message.metadata as {
      attachments?: unknown;
      isReplyToBot?: boolean;
    };
    const attachments = metadata?.attachments ?? [];
    const isReplyToBot = metadata?.isReplyToBot ?? false;

    // Allow messages with only attachments (no text)
    if (!text && (!Array.isArray(attachments) || attachments.length === 0))
      return;

    const defaultPatterns = config.triggerPatterns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const triggerConfig = loadTriggerConfig(core.db, thread.id, {
      patterns: defaultPatterns,
      match: config.triggerMatch,
    });
    const triggerResult = matchTrigger(text, triggerConfig, isDM);

    // Start typing if trigger matched, DM, or reply to bot
    const shouldStartTyping = triggerResult.matched || (isReplyToBot && !isDM);
    if (shouldStartTyping) {
      if (isNew) await thread.subscribe();
      await thread.startTyping();
    }

    // Construct IngressMessage for the new handleRawInput signature
    const ingress: IngressMessage = {
      platform: thread.adapter.name,
      groupId: thread.id,
      callerId,
      authorName: message.author.userName,
      text: message.text,
      isDM,
      isReplyToBot,
      attachments: Array.isArray(attachments) ? attachments : [],
    };

    const result = await core.handleRawInput(ingress, "chat-sdk");

    if (result.type === "ignore") return;

    if (result.type === "assistant" && result.result?.reply) {
      await thread.post(result.result.reply);
    } else if (result.type === "command" && result.result?.reply) {
      await thread.post(result.result.reply);
    } else if (result.type === "denied") {
      await thread.post(result.reason);
    }
  };
}
