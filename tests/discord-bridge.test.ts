import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Message, parseMarkdown } from "chat";
import { DiscordBridge } from "../src/bridges/discord.js";
import type { EgressFile, NormalizeContext } from "../src/types.js";

// ─── Mock Adapter ───────────────────────────────────────────────────────

function createMockAdapter(opts?: {
  botUserId?: string;
  channelSendable?: boolean;
}) {
  const postCalls: { threadId: string; text: string }[] = [];
  const sendCalls: { content: unknown; files: unknown[] }[] = [];

  const mockChannel = {
    send: async (opts: { content?: string; files?: unknown[] }) => {
      sendCalls.push({ content: opts.content, files: opts.files ?? [] });
    },
  };

  const mockClient = {
    channels: {
      fetch: async (_id: string) =>
        opts?.channelSendable === false ? {} : mockChannel,
    },
  };

  return {
    adapter: {
      postMessage: async (threadId: string, message: unknown) => {
        const text = typeof message === "string" ? message : String(message);
        postCalls.push({ threadId, text });
        return { id: "mock", threadId, raw: {} };
      },
      decodeThreadId: (threadId: string) => {
        const parts = threadId.split(":");
        return {
          guildId: parts[1] || "guild",
          channelId: parts[2] || "channel",
          threadId: parts[3],
        };
      },
      get botUserId() {
        return opts?.botUserId ?? "bot123";
      },
      get discordClient() {
        return mockClient;
      },
    },
    postCalls,
    sendCalls,
  };
}

function makeMessage(overrides: {
  text?: string;
  isMe?: boolean;
  userId?: string;
  userName?: string;
  metadata?: Record<string, unknown>;
  attachments?: {
    url?: string;
    name?: string;
    size?: number;
    mimeType?: string;
  }[];
}): Message {
  return new Message({
    id: "msg-1",
    threadId: "discord:guild1:channel1",
    text: overrides.text ?? "hello",
    formatted: parseMarkdown(overrides.text ?? "hello"),
    raw: {},
    author: {
      userId: overrides.userId ?? "user456",
      userName: overrides.userName ?? "TestUser",
      fullName: overrides.userName ?? "TestUser",
      isBot: false,
      isMe: overrides.isMe ?? false,
    },
    metadata: {
      dateSent: new Date(),
      edited: false,
      ...(overrides.metadata ?? {}),
    },
    attachments: overrides.attachments ?? [],
  });
}

const defaultCtx: NormalizeContext = {
  botUserName: "mercury",
  getWorkspace: () => null, // no workspace = no media download
  media: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
};

// ─── Tests ──────────────────────────────────────────────────────────────

describe("DiscordBridge", () => {
  describe("groupId", () => {
    test("returns threadId unchanged", () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      expect(bridge.groupId("discord:guild1:channel1")).toBe(
        "discord:guild1:channel1",
      );
    });
  });

  describe("isDM", () => {
    test("returns true for @me guild", () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      expect(bridge.isDM("discord:@me:channel1")).toBe(true);
    });

    test("returns false for regular guild", () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      expect(bridge.isDM("discord:guild1:channel1")).toBe(false);
    });

    test("returns false for malformed thread ID", () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      expect(bridge.isDM("something")).toBe(false);
    });
  });

  describe("normalize", () => {
    test("returns null for bot own messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ isMe: true });
      expect(await bridge.normalize("discord:g:c", msg, defaultCtx)).toBeNull();
    });

    test("returns null for empty messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ text: "" });
      expect(await bridge.normalize("discord:g:c", msg, defaultCtx)).toBeNull();
    });

    test("converts bot mentions to @userName", async () => {
      const { adapter } = createMockAdapter({ botUserId: "bot123" });
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ text: "hey <@bot123> do something" });
      const result = await bridge.normalize("discord:g:c", msg, defaultCtx);
      expect(result!.text).toBe("hey @mercury do something");
    });

    test("converts bot mentions with ! format", async () => {
      const { adapter } = createMockAdapter({ botUserId: "bot123" });
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ text: "<@!bot123> help" });
      const result = await bridge.normalize("discord:g:c", msg, defaultCtx);
      expect(result!.text).toBe("@mercury help");
    });

    test("extracts isReplyToBot from metadata", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({
        text: "reply",
        metadata: { isReplyToBot: true },
      });
      const result = await bridge.normalize("discord:g:c", msg, defaultCtx);
      expect(result!.isReplyToBot).toBe(true);
    });

    test("defaults isReplyToBot to false", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ text: "hello" });
      const result = await bridge.normalize("discord:g:c", msg, defaultCtx);
      expect(result!.isReplyToBot).toBe(false);
    });

    test("builds correct IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({
        text: "hello",
        userId: "user789",
        userName: "Alice",
      });
      const result = await bridge.normalize(
        "discord:guild1:channel1",
        msg,
        defaultCtx,
      );
      expect(result).toEqual({
        platform: "discord",
        groupId: "discord:guild1:channel1",
        callerId: "discord:user789",
        authorName: "Alice",
        text: "hello",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      });
    });

    test("DM detection in IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const msg = makeMessage({ text: "hi" });
      const result = await bridge.normalize(
        "discord:@me:channel1",
        msg,
        defaultCtx,
      );
      expect(result!.isDM).toBe(true);
    });
  });

  describe("sendReply", () => {
    test("text-only calls adapter.postMessage", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      await bridge.sendReply("discord:guild1:channel1", "hello");
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("hello");
    });

    test("no-op for empty text and no files", async () => {
      const { adapter, postCalls, sendCalls } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      await bridge.sendReply("discord:guild1:channel1", "");
      expect(postCalls).toHaveLength(0);
      expect(sendCalls).toHaveLength(0);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-bridge-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function tmpFile(name: string, content = "test"): EgressFile {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, content);
      return {
        path: filePath,
        filename: name,
        mimeType: "image/png",
        sizeBytes: Buffer.byteLength(content),
      };
    }

    test("sends text + files in one message via channel.send", async () => {
      const { adapter, sendCalls } = createMockAdapter();
      const bridge = new DiscordBridge(adapter as never);
      const file = tmpFile("chart.png");

      await bridge.sendReply("discord:guild1:channel1", "here it is", [file]);

      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0].content).toBe("here it is");
      expect(sendCalls[0].files).toHaveLength(1);
      expect((sendCalls[0].files[0] as { name: string }).name).toBe(
        "chart.png",
      );
    });

    test("falls back to postMessage if channel not sendable", async () => {
      const { adapter, postCalls } = createMockAdapter({
        channelSendable: false,
      });
      const bridge = new DiscordBridge(adapter as never);
      const file = tmpFile("chart.png");

      await bridge.sendReply("discord:guild1:channel1", "fallback", [file]);

      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("fallback");
    });
  });
});
