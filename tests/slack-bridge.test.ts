import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Message, parseMarkdown } from "chat";
import { SlackBridge } from "../src/bridges/slack.js";
import type { EgressFile, NormalizeContext } from "../src/types.js";

// ─── Mock Adapter ───────────────────────────────────────────────────────

function createMockAdapter() {
  const postCalls: { threadId: string; text: string }[] = [];

  return {
    adapter: {
      postMessage: async (threadId: string, message: unknown) => {
        const text = typeof message === "string" ? message : String(message);
        postCalls.push({ threadId, text });
        return { id: "mock", threadId, raw: {} };
      },
    },
    postCalls,
  };
}

function makeMessage(overrides: {
  text?: string;
  isMe?: boolean;
  userId?: string;
  userName?: string;
  attachments?: {
    url?: string;
    name?: string;
    size?: number;
    mimeType?: string;
  }[];
}): Message {
  return new Message({
    id: "msg-1",
    threadId: "slack:C123:1234.5678",
    text: overrides.text ?? "hello",
    formatted: parseMarkdown(overrides.text ?? "hello"),
    raw: {},
    author: {
      userId: overrides.userId ?? "U456",
      userName: overrides.userName ?? "TestUser",
      fullName: overrides.userName ?? "TestUser",
      isBot: false,
      isMe: overrides.isMe ?? false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: overrides.attachments ?? [],
  });
}

const defaultCtx: NormalizeContext = {
  botUserName: "mercury",
  getWorkspace: () => null,
  media: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
};

// ─── Tests ──────────────────────────────────────────────────────────────

describe("SlackBridge", () => {
  describe("groupId", () => {
    test("strips thread timestamp", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.groupId("slack:C123:1234.5678")).toBe("slack:C123");
    });

    test("handles thread ID without timestamp", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.groupId("slack:C123")).toBe("slack:C123");
    });

    test("returns raw ID for non-slack format", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.groupId("something-else")).toBe("something-else");
    });
  });

  describe("isDM", () => {
    test("returns true for D-prefixed channels", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.isDM("slack:D123:ts")).toBe(true);
    });

    test("returns true for G-prefixed channels (group DMs)", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.isDM("slack:G456:ts")).toBe(true);
    });

    test("returns false for C-prefixed channels", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.isDM("slack:C789:ts")).toBe(false);
    });

    test("returns false for non-slack format", () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      expect(bridge.isDM("other:thing")).toBe(false);
    });
  });

  describe("normalize", () => {
    test("returns null for bot own messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const msg = makeMessage({ isMe: true });
      expect(
        await bridge.normalize("slack:C123:ts", msg, defaultCtx),
      ).toBeNull();
    });

    test("returns null for empty messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const msg = makeMessage({ text: "" });
      expect(
        await bridge.normalize("slack:C123:ts", msg, defaultCtx),
      ).toBeNull();
    });

    test("always sets isReplyToBot to false", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const msg = makeMessage({ text: "hello" });
      const result = await bridge.normalize("slack:C123:ts", msg, defaultCtx);
      expect(result!.isReplyToBot).toBe(false);
    });

    test("builds correct IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const msg = makeMessage({
        text: "hello",
        userId: "U789",
        userName: "Bob",
      });
      const result = await bridge.normalize(
        "slack:C123:1234.5678",
        msg,
        defaultCtx,
      );
      expect(result).toEqual({
        platform: "slack",
        groupId: "slack:C123",
        callerId: "slack:U789",
        authorName: "Bob",
        text: "hello",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      });
    });

    test("DM detection in IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const msg = makeMessage({ text: "hi" });
      const result = await bridge.normalize(
        "slack:D123:1234.5678",
        msg,
        defaultCtx,
      );
      expect(result!.isDM).toBe(true);
    });
  });

  describe("sendReply", () => {
    test("text-only calls adapter.postMessage", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      await bridge.sendReply("slack:C123:ts", "hello");
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("hello");
    });

    test("no-op for empty text and no files", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      await bridge.sendReply("slack:C123:ts", "");
      expect(postCalls).toHaveLength(0);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-test-"));
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
        mimeType: "application/pdf",
        sizeBytes: Buffer.byteLength(content),
      };
    }

    test("sends text via postMessage then uploads files", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const file = tmpFile("report.pdf");

      await bridge.sendReply("slack:C123:ts", "here's the report", [file]);

      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("here's the report");
    });

    test("skips text if empty, still attempts file upload", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new SlackBridge(adapter as never, "xoxb-token");
      const file = tmpFile("data.pdf");

      await bridge.sendReply("slack:C123:ts", "", [file]);

      expect(postCalls).toHaveLength(0);
    });
  });
});
