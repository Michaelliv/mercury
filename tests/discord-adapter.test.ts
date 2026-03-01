import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDiscordMessageHandler,
  discordCallerId,
  isDiscordDM,
} from "../src/adapters/discord.js";
import { type AppConfig, loadConfig } from "../src/config.js";
import { seededGroups } from "../src/core/permissions.js";
import type { MercuryCoreRuntime } from "../src/core/runtime.js";
import { Db } from "../src/storage/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-discord-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
  seededGroups.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: isDiscordDM
// ---------------------------------------------------------------------------

describe("isDiscordDM", () => {
  test("returns true for DM threads", () => {
    expect(isDiscordDM("discord:@me:444555666")).toBe(true);
  });

  test("returns false for guild threads", () => {
    expect(isDiscordDM("discord:111222333:444555666")).toBe(false);
  });

  test("returns false for non-discord threads", () => {
    expect(isDiscordDM("whatsapp:123@g.us:123@g.us")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: discordCallerId
// ---------------------------------------------------------------------------

describe("discordCallerId", () => {
  test("prefixes userId with discord:", () => {
    const msg = fakeMessage({ userId: "123456789" });
    expect(discordCallerId(msg)).toBe("discord:123456789");
  });

  test("handles missing userId", () => {
    const msg = fakeMessage({ userId: "" });
    expect(discordCallerId(msg)).toBe("discord:unknown");
  });
});

// ---------------------------------------------------------------------------
// Integration: createDiscordMessageHandler
// ---------------------------------------------------------------------------

describe("createDiscordMessageHandler", () => {
  test("ignores messages from self", async () => {
    const { handler, thread } = setup();
    const msg = fakeMessage({ isMe: true, text: "@Pi hello" });
    await handler(thread, msg, true);
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("ignores empty messages", async () => {
    const { handler, thread } = setup();
    const msg = fakeMessage({ text: "   " });
    await handler(thread, msg, true);
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("routes triggered message and posts reply", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "assistant" as const,
      prompt: "hello",
      callerId: "discord:U123",
      role: "member",
      reply: "Hi there!",
    }));

    const msg = fakeMessage({ text: "@Pi hello", userId: "U123" });
    await handler(thread, msg, true);

    expect(core.handleRawInput).toHaveBeenCalledTimes(1);
    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    expect(call.groupId).toBe("discord:111222333:444555666");
    expect(call.callerId).toBe("discord:U123");
    expect(call.isDM).toBe(false);
    expect(call.source).toBe("chat-sdk");

    expect(thread.post).toHaveBeenCalledWith("Hi there!");
    expect(thread.subscribe).toHaveBeenCalled();
    expect(thread.startTyping).toHaveBeenCalled();
  });

  test("stores ambient messages for non-triggered group messages", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "ignore" as const,
    }));

    const msg = fakeMessage({ text: "just chatting", userId: "U456" });
    await handler(thread, msg, true);

    expect(core.handleRawInput).toHaveBeenCalledTimes(1);
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("handles DM channel correctly", async () => {
    const { handler, core } = setup();
    const dmThread = fakeThread("discord:@me:444555666");
    core.handleRawInput = mock(async () => ({
      type: "assistant" as const,
      prompt: "hello",
      callerId: "discord:U123",
      role: "member",
      reply: "Hi from DM!",
    }));

    const msg = fakeMessage({ text: "hello", userId: "U123" });
    await handler(dmThread, msg, true);

    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    expect(call.groupId).toBe("discord:@me:444555666");
    expect(call.isDM).toBe(true);

    expect(dmThread.post).toHaveBeenCalledWith("Hi from DM!");
  });

  test("posts denial reason", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "denied" as const,
      reason: "No permission.",
    }));

    const msg = fakeMessage({ text: "@Pi do stuff" });
    await handler(thread, msg, true);

    expect(thread.post).toHaveBeenCalledWith("No permission.");
  });

  test("handles command result", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "command" as const,
      command: "stop",
      callerId: "discord:U123",
      role: "admin",
      reply: "Stopped.",
    }));

    const msg = fakeMessage({ text: "@Pi stop" });
    await handler(thread, msg, true);

    expect(thread.post).toHaveBeenCalledWith("Stopped.");
    expect(thread.startTyping).toHaveBeenCalled();
  });

  test("fires typing indicator before handleRawInput (early typing)", async () => {
    const { handler, thread, core } = setup();
    const callOrder: string[] = [];

    thread.startTyping = mock(async () => {
      callOrder.push("startTyping");
    });
    core.handleRawInput = mock(async () => {
      callOrder.push("handleRawInput");
      return {
        type: "assistant" as const,
        prompt: "hello",
        callerId: "discord:U123",
        role: "member",
        reply: "Hi!",
      };
    });

    const msg = fakeMessage({ text: "@Pi hello", userId: "U123" });
    await handler(thread, msg, true);

    expect(callOrder).toEqual(["startTyping", "handleRawInput"]);
  });

  test("catches and logs errors from handleRawInput", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => {
      throw new Error("boom");
    });

    const msg = fakeMessage({ text: "@Pi explode" });
    // Should not throw — error is caught and logged
    await handler(thread, msg, true);

    expect(thread.post).not.toHaveBeenCalled();
  });

  test("does not subscribe/startTyping for ignored messages", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "ignore" as const,
    }));

    const msg = fakeMessage({ text: "random chatter" });
    await handler(thread, msg, true);

    expect(thread.subscribe).not.toHaveBeenCalled();
    expect(thread.startTyping).not.toHaveBeenCalled();
    expect(thread.post).not.toHaveBeenCalled();
  });

  test("does not subscribe for follow-up messages (isNew=false)", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "assistant" as const,
      prompt: "hi",
      callerId: "discord:U123",
      role: "member",
      reply: "Hello!",
    }));

    const msg = fakeMessage({ text: "@Pi hi" });
    await handler(thread, msg, false);

    expect(thread.subscribe).not.toHaveBeenCalled();
    expect(thread.startTyping).toHaveBeenCalled();
    expect(thread.post).toHaveBeenCalledWith("Hello!");
  });

  test("passes authorName to handleRawInput", async () => {
    const { handler, thread, core } = setup();
    core.handleRawInput = mock(async () => ({
      type: "ignore" as const,
    }));

    const msg = fakeMessage({
      text: "hello",
      userId: "U789",
      userName: "alice",
    });
    await handler(thread, msg, true);

    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    expect(call.authorName).toBe("alice");
  });

  test("uses thread ID with sub-thread for correct group derivation", async () => {
    const { handler, core } = setup();
    // Thread inside a channel: discord:guildId:channelId:threadId
    const subThread = fakeThread("discord:111222333:444555666:999000111");
    core.handleRawInput = mock(async () => ({
      type: "ignore" as const,
    }));

    const msg = fakeMessage({ text: "in a thread" });
    await handler(subThread, msg, true);

    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    // Group ID is now the full thread ID (including guild and sub-thread)
    expect(call.groupId).toBe("discord:111222333:444555666:999000111");
  });
});

// ---------------------------------------------------------------------------
// createDiscordAdapter
// ---------------------------------------------------------------------------

describe("createDiscordAdapter", () => {
  test("throws without env vars", () => {
    const saved = {
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
      DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
    };
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_PUBLIC_KEY;
    delete process.env.DISCORD_APPLICATION_ID;

    try {
      const { createDiscordAdapter } = require("../src/adapters/discord.js");
      expect(() => createDiscordAdapter()).toThrow("Discord adapter requires");
    } finally {
      if (saved.DISCORD_BOT_TOKEN)
        process.env.DISCORD_BOT_TOKEN = saved.DISCORD_BOT_TOKEN;
      if (saved.DISCORD_PUBLIC_KEY)
        process.env.DISCORD_PUBLIC_KEY = saved.DISCORD_PUBLIC_KEY;
      if (saved.DISCORD_APPLICATION_ID)
        process.env.DISCORD_APPLICATION_ID = saved.DISCORD_APPLICATION_ID;
    }
  });
});

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function fakeMessage(opts: {
  text?: string;
  userId?: string;
  userName?: string;
  isMe?: boolean;
}): unknown {
  return {
    text: opts.text ?? "",
    author: {
      userId: opts.userId ?? "U_TEST",
      userName: opts.userName ?? "testuser",
      fullName: opts.userName ?? "testuser",
      isBot: false,
      isMe: opts.isMe ?? false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
  };
}

function fakeThread(threadId = "discord:111222333:444555666"): unknown {
  return {
    id: threadId,
    isDM: threadId.split(":")[1] === "@me",
    adapter: { name: "discord" },
    post: mock(async () => {}),
    subscribe: mock(async () => {}),
    startTyping: mock(async () => {}),
  };
}

function setup() {
  const config: AppConfig = {
    ...loadConfig(),
    admins: "",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
    dataDir: tmpDir,
    dbPath: path.join(tmpDir, "state.db"),
    globalDir: path.join(tmpDir, "global"),
    groupsDir: path.join(tmpDir, "groups"),
    whatsappAuthDir: path.join(tmpDir, "wa-auth"),
  };

  // Partial mock of MercuryCoreRuntime — we only need handleRawInput
  const core = {
    handleRawInput: mock(async () => ({ type: "ignore" as const })),
  } as unknown as MercuryCoreRuntime;

  const handler = createDiscordMessageHandler({ core, db, config });
  const thread = fakeThread();

  return { handler, thread, core };
}
