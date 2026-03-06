/**
 * Discord adapter factory for the webhook-based (serverless) adapter.
 *
 * Note: Mercury primarily uses the native adapter (discord-native.ts) with
 * persistent WebSocket. This factory is kept for potential fallback use.
 */

import {
  createDiscordAdapter as createBaseDiscordAdapter,
  type DiscordAdapter,
  type DiscordThreadId,
} from "@chat-adapter/discord";
import { logger } from "../logger.js";

export type { DiscordAdapter, DiscordThreadId };

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
