import type { Message, Thread } from "chat";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { NormalizeContext, PlatformBridge } from "../types.js";
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

  return async (
    thread: Thread,
    message: Message,
    isNew: boolean,
  ): Promise<void> => {
    try {
      if (message.author.isMe) return;

      const text = message.text.trim();
      if (!text && (!message.attachments || message.attachments.length === 0)) {
        return;
      }

      const groupId = bridge.groupId(thread.id);
      const isDM = bridge.isDM(thread.id);

      const defaultPatterns = config.triggerPatterns
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const triggerConfig = loadTriggerConfig(core.db, groupId, {
        patterns: defaultPatterns,
        match: config.triggerMatch,
      });
      const triggerResult = matchTrigger(text, triggerConfig, isDM);

      if (triggerResult.matched) {
        if (isNew) await thread.subscribe();
        await thread.startTyping();
      }

      const ingress = await bridge.normalize(thread.id, message, ctx);
      if (!ingress) return;

      if (ingress.isReplyToBot && !isDM && !triggerResult.matched) {
        if (isNew) await thread.subscribe();
        await thread.startTyping();
      }

      const result = await core.handleRawInput(ingress, "chat-sdk");

      if (result.type === "ignore") return;

      if (result.type === "denied") {
        await bridge.sendReply(thread.id, result.reason);
        return;
      }

      if (result.result) {
        const { reply, files } = result.result;
        if (reply || files.length > 0) {
          await bridge.sendReply(
            thread.id,
            reply,
            files.length > 0 ? files : undefined,
          );
        }
      }
    } catch (err) {
      logger.error("Message handler error", {
        platform: bridge.platform,
        threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
