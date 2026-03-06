import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// createDiscordAdapter
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  test("throws without env vars", () => {
    const saved = {
      MERCURY_DISCORD_BOT_TOKEN: process.env.MERCURY_DISCORD_BOT_TOKEN,
      MERCURY_DISCORD_PUBLIC_KEY: process.env.MERCURY_DISCORD_PUBLIC_KEY,
      MERCURY_DISCORD_APPLICATION_ID:
        process.env.MERCURY_DISCORD_APPLICATION_ID,
    };
    delete process.env.MERCURY_DISCORD_BOT_TOKEN;
    delete process.env.MERCURY_DISCORD_PUBLIC_KEY;
    delete process.env.MERCURY_DISCORD_APPLICATION_ID;

    try {
      const { createDiscordAdapter } = require("../src/adapters/discord.js");
      expect(() => createDiscordAdapter()).toThrow("Discord adapter requires");
    } finally {
      if (saved.MERCURY_DISCORD_BOT_TOKEN)
        process.env.MERCURY_DISCORD_BOT_TOKEN = saved.MERCURY_DISCORD_BOT_TOKEN;
      if (saved.MERCURY_DISCORD_PUBLIC_KEY)
        process.env.MERCURY_DISCORD_PUBLIC_KEY =
          saved.MERCURY_DISCORD_PUBLIC_KEY;
      if (saved.MERCURY_DISCORD_APPLICATION_ID)
        process.env.MERCURY_DISCORD_APPLICATION_ID =
          saved.MERCURY_DISCORD_APPLICATION_ID;
    }
  });
});
