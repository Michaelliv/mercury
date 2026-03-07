import type { Adapter, Message } from "chat";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { NormalizeContext, PlatformBridge } from "../types.js";
import { inferConversationKind, resolveConversation } from "./conversation.js";
import type { MercuryCoreRuntime } from "./runtime.js";
import { loadTriggerConfig, matchTrigger } from "./trigger.js";

export interface MessageHandlerOptions {
  bridge: PlatformBridge;
  core: MercuryCoreRuntime;
  config: AppConfig;
  ctx: NormalizeContext;
}

export function createMessageHandler(opts: MessageHandlerOptions) {
  const { bridge, core, config, ctx } = opts;
  const defaultPatterns = config.triggerPatterns
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);

  return async (
    adapter: Adapter,
    threadId: string,
    message: Message,
  ): Promise<void> => {
    try {
      if (message.author.isMe) return;

      const text = message.text.trim();
      if (!text && (!message.attachments || message.attachments.length === 0)) {
        return;
      }

      const { externalId, isDM } = bridge.parseThread(threadId);
      const kind = inferConversationKind(bridge.platform, externalId, isDM);
      const resolution = resolveConversation(
        core.db,
        bridge.platform,
        externalId,
        kind,
      );

      if (!resolution) return;

      const { spaceId } = resolution;

      const triggerConfig = loadTriggerConfig(core.db, spaceId, {
        patterns: defaultPatterns,
        match: config.triggerMatch,
      });
      const triggerResult = matchTrigger(text, triggerConfig, isDM);

      if (triggerResult.matched) {
        try {
          await adapter.startTyping(threadId);
        } catch {
          // Best-effort typing indicator
        }
      }

      const ingress = await bridge.normalize(threadId, message, ctx, spaceId);
      if (!ingress) return;

      if (ingress.isReplyToBot && !isDM && !triggerResult.matched) {
        try {
          await adapter.startTyping(threadId);
        } catch {
          // Best-effort typing indicator
        }
      }

      const result = await core.handleRawInput(ingress, "chat-sdk");

      if (result.type === "ignore") return;

      if (result.type === "denied") {
        await bridge.sendReply(threadId, result.reason);
        return;
      }

      if (result.result) {
        const { reply, files } = result.result;
        if (reply || files.length > 0) {
          await bridge.sendReply(
            threadId,
            reply,
            files.length > 0 ? files : undefined,
          );
        }
      }
    } catch (err) {
      logger.error("Message handler error", {
        platform: bridge.platform,
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
