/**
 * Minimal ChatInstance shim that satisfies the Chat SDK adapter interface
 * without the full Chat routing pipeline.
 *
 * Mercury uses its own message routing (conversation resolution, trigger matching,
 * space queues). The Chat SDK's subscription/mention routing adds no value here.
 *
 * This shim:
 * - Routes processMessage() directly to Mercury's handler callback
 * - Provides a minimal in-memory StateAdapter for adapters that need caching
 *   (e.g., Slack adapter caches user display names)
 * - Stubs out action/modal/slash-command processing (Mercury doesn't use these)
 */

import type {
  Adapter,
  ChatInstance,
  Logger,
  Message,
  StateAdapter,
  WebhookOptions,
} from "chat";
import { logger as mercuryLogger } from "./logger.js";

/** Callback invoked when an adapter receives a message */
export type MessageCallback = (
  adapter: Adapter,
  threadId: string,
  message: Message,
) => void;

/** Pino-to-Chat SDK logger bridge */
class PinoLoggerBridge implements Logger {
  private readonly prefix: string;

  constructor(prefix = "") {
    this.prefix = prefix;
  }

  child(childPrefix: string): Logger {
    const combined = this.prefix
      ? `${this.prefix}:${childPrefix}`
      : childPrefix;
    return new PinoLoggerBridge(combined);
  }

  debug(message: string, ..._args: unknown[]): void {
    mercuryLogger.debug(this.prefix ? `[${this.prefix}] ${message}` : message);
  }

  info(message: string, ..._args: unknown[]): void {
    mercuryLogger.info(this.prefix ? `[${this.prefix}] ${message}` : message);
  }

  warn(message: string, ..._args: unknown[]): void {
    mercuryLogger.warn(this.prefix ? `[${this.prefix}] ${message}` : message);
  }

  error(message: string, ..._args: unknown[]): void {
    mercuryLogger.error(this.prefix ? `[${this.prefix}] ${message}` : message);
  }
}

/**
 * Minimal in-memory StateAdapter for adapter-internal caching needs.
 * NOT used for Mercury's own state (that's in SQLite).
 */
class MinimalStateAdapter implements StateAdapter {
  private readonly cache = new Map<
    string,
    { value: unknown; expiresAt: number | null }
  >();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.cache.clear();
  }

  // Subscriptions — Mercury doesn't use Chat SDK subscriptions
  async subscribe(_threadId: string): Promise<void> {}
  async unsubscribe(_threadId: string): Promise<void> {}
  async isSubscribed(_threadId: string): Promise<boolean> {
    return false;
  }

  // Locks — Mercury has its own SpaceQueue
  async acquireLock(
    _threadId: string,
    _ttlMs: number,
  ): Promise<{ threadId: string; token: string; expiresAt: number } | null> {
    // Always grant — Mercury handles its own concurrency
    return {
      threadId: _threadId,
      token: `shim_${Date.now()}`,
      expiresAt: Date.now() + _ttlMs,
    };
  }

  async releaseLock(_lock: {
    threadId: string;
    token: string;
    expiresAt: number;
  }): Promise<void> {}

  async extendLock(
    _lock: { threadId: string; token: string; expiresAt: number },
    _ttlMs: number,
  ): Promise<boolean> {
    return true;
  }

  // Cache — used by Slack adapter for user display name caching
  async get<T = unknown>(key: string): Promise<T | null> {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt !== null && cached.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cached.value as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }
}

/**
 * Create a minimal ChatInstance shim.
 *
 * @param onMessage - Called when any adapter receives a message.
 *   Mercury's handler is wired here instead of Chat SDK's event routing.
 */
export function createChatShim(onMessage: MessageCallback): ChatInstance {
  const state = new MinimalStateAdapter();
  const chatLogger = new PinoLoggerBridge("chat-shim");

  return {
    getLogger(prefix?: string): Logger {
      return prefix ? chatLogger.child(prefix) : chatLogger;
    },

    getState(): StateAdapter {
      return state;
    },

    getUserName(): string {
      return "mercury";
    },

    // Deprecated — but Slack adapter may still call it
    async handleIncomingMessage(
      adapter: Adapter,
      threadId: string,
      message: Message,
    ): Promise<void> {
      onMessage(adapter, threadId, message);
    },

    processMessage(
      adapter: Adapter,
      threadId: string,
      message: Message | (() => Promise<Message>),
      _options?: WebhookOptions,
    ): void {
      void (async () => {
        try {
          const msg = typeof message === "function" ? await message() : message;

          // Skip bot's own messages
          if (msg.author.isMe) return;

          onMessage(adapter, threadId, msg);
        } catch (err) {
          chatLogger.error(
            "processMessage failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    },

    // Stubs — Mercury doesn't use these Chat SDK features
    processAction(_event, _options?): void {},
    processAppHomeOpened(_event, _options?): void {},
    processAssistantContextChanged(_event, _options?): void {},
    processAssistantThreadStarted(_event, _options?): void {},
    processModalClose(_event, _contextId?, _options?): void {},
    async processModalSubmit(_event, _contextId?, _options?) {
      return undefined;
    },
    processReaction(_event, _options?): void {},
    processSlashCommand(_event, _options?): void {},
  };
}
