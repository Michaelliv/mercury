import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Message, parseMarkdown } from "chat";
import { WhatsAppBridge } from "../src/bridges/whatsapp.js";
import type {
  EgressFile,
  MessageAttachment,
  NormalizeContext,
} from "../src/types.js";

// ─── Mock Adapter ───────────────────────────────────────────────────────

function createMockAdapter(opts?: { socket?: unknown; noSocket?: boolean }) {
  const postCalls: { threadId: string; text: string }[] = [];
  const socketCalls: { jid: string; content: unknown }[] = [];

  const mockSocket = opts?.noSocket
    ? undefined
    : (opts?.socket ?? {
        sendMessage: async (jid: string, content: unknown) => {
          socketCalls.push({ jid, content });
        },
      });

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
          chatJid: parts[1] || "unknown",
          threadJid: parts.slice(2).join(":") || parts[1] || "unknown",
        };
      },
      get socket() {
        return mockSocket;
      },
    },
    postCalls,
    socketCalls,
  };
}

function makeMessage(overrides: {
  text?: string;
  isMe?: boolean;
  userId?: string;
  userName?: string;
  metadata?: Record<string, unknown>;
}): Message {
  return new Message({
    id: "msg-1",
    threadId: "whatsapp:group@g.us:group@g.us",
    text: overrides.text ?? "hello",
    formatted: parseMarkdown(overrides.text ?? "hello"),
    raw: {},
    author: {
      userId: overrides.userId ?? "user@s.whatsapp.net",
      userName: overrides.userName ?? "TestUser",
      fullName: overrides.userName ?? "TestUser",
      isBot: "unknown",
      isMe: overrides.isMe ?? false,
    },
    metadata: {
      dateSent: new Date(),
      edited: false,
      ...(overrides.metadata ?? {}),
    },
    attachments: [],
  });
}

const defaultCtx: NormalizeContext = {
  botUserName: "mercury",
  getWorkspace: () => "/tmp/test-workspace",
  media: { enabled: true, maxSizeBytes: 10 * 1024 * 1024 },
};

// ─── Tests ──────────────────────────────────────────────────────────────

describe("WhatsAppBridge", () => {
  describe("groupId", () => {
    test("returns threadId unchanged", () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      expect(bridge.groupId("whatsapp:group@g.us:group@g.us")).toBe(
        "whatsapp:group@g.us:group@g.us",
      );
    });
  });

  describe("isDM", () => {
    test("returns false for group JIDs", () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      expect(bridge.isDM("whatsapp:123456@g.us:123456@g.us")).toBe(false);
    });

    test("returns true for non-group JIDs", () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      expect(
        bridge.isDM("whatsapp:123@s.whatsapp.net:123@s.whatsapp.net"),
      ).toBe(true);
    });

    test("returns true for LID JIDs", () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      expect(bridge.isDM("whatsapp:123@lid:456@lid")).toBe(true);
    });
  });

  describe("normalize", () => {
    test("returns null for bot own messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({ isMe: true });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result).toBeNull();
    });

    test("returns null for empty messages with no attachments", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({ text: "" });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result).toBeNull();
    });

    test("returns null for whitespace-only messages", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({ text: "   \n  " });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result).toBeNull();
    });

    test("extracts attachments from metadata", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const attachments: MessageAttachment[] = [
        { path: "/tmp/photo.jpg", type: "image", mimeType: "image/jpeg" },
      ];
      const msg = makeMessage({ text: "", metadata: { attachments } });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result).not.toBeNull();
      expect(result!.attachments).toEqual(attachments);
    });

    test("extracts isReplyToBot from metadata", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({
        text: "hello",
        metadata: { isReplyToBot: true },
      });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result!.isReplyToBot).toBe(true);
    });

    test("defaults isReplyToBot to false when missing", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({ text: "hello" });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result!.isReplyToBot).toBe(false);
    });

    test("defaults attachments to empty array when missing", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const msg = makeMessage({ text: "hello" });
      const result = await bridge.normalize(
        "whatsapp:group@g.us:group@g.us",
        msg,
        defaultCtx,
      );
      expect(result!.attachments).toEqual([]);
    });

    test("builds correct IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const threadId = "whatsapp:group@g.us:group@g.us";
      const msg = makeMessage({
        text: "hi there",
        userId: "user1@s.whatsapp.net",
        userName: "Alice",
      });
      const result = await bridge.normalize(threadId, msg, defaultCtx);

      expect(result).toEqual({
        platform: "whatsapp",
        groupId: threadId,
        callerId: "whatsapp:user1@s.whatsapp.net",
        authorName: "Alice",
        text: "hi there",
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      });
    });

    test("DM detection in IngressMessage", async () => {
      const { adapter } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const threadId = "whatsapp:123@s.whatsapp.net:123@s.whatsapp.net";
      const msg = makeMessage({ text: "hello" });
      const result = await bridge.normalize(threadId, msg, defaultCtx);
      expect(result!.isDM).toBe(true);
    });
  });

  describe("sendReply", () => {
    test("text-only calls adapter.postMessage", async () => {
      const { adapter, postCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "hello");
      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("hello");
    });

    test("no-op for empty text and no files", async () => {
      const { adapter, postCalls, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "");
      expect(postCalls).toHaveLength(0);
      expect(socketCalls).toHaveLength(0);
    });

    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-bridge-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function tmpFile(name: string, content = "test"): EgressFile {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, content);
      const ext = name.split(".").pop() ?? "";
      const mimeMap: Record<string, string> = {
        jpg: "image/jpeg",
        png: "image/png",
        mp4: "video/mp4",
        ogg: "audio/ogg",
        pdf: "application/pdf",
      };
      return {
        path: filePath,
        filename: name,
        mimeType: mimeMap[ext] ?? "application/octet-stream",
        sizeBytes: Buffer.byteLength(content),
      };
    }

    test("sends image with caption via socket", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const file = tmpFile("photo.jpg");

      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "look at this", [
        file,
      ]);

      expect(socketCalls).toHaveLength(1);
      expect(socketCalls[0].jid).toBe("group@g.us");
      const content = socketCalls[0].content as Record<string, unknown>;
      expect(content.image).toBeInstanceOf(Buffer);
      expect(content.caption).toBe("look at this");
      expect(content.mimetype).toBe("image/jpeg");
    });

    test("sends video with caption via socket", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const file = tmpFile("clip.mp4");

      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "watch this", [
        file,
      ]);

      expect(socketCalls).toHaveLength(1);
      const content = socketCalls[0].content as Record<string, unknown>;
      expect(content.video).toBeInstanceOf(Buffer);
      expect(content.caption).toBe("watch this");
    });

    test("sends audio without caption, text separately", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const file = tmpFile("voice.ogg");

      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "here it is", [
        file,
      ]);

      expect(socketCalls).toHaveLength(2);
      const audioContent = socketCalls[0].content as Record<string, unknown>;
      expect(audioContent.audio).toBeInstanceOf(Buffer);
      expect(audioContent.ptt).toBe(false);
      expect(audioContent.caption).toBeUndefined();

      const textContent = socketCalls[1].content as Record<string, unknown>;
      expect(textContent.text).toBe("here it is");
    });

    test("sends document with fileName via socket", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const file = tmpFile("report.pdf");

      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "the report", [
        file,
      ]);

      expect(socketCalls).toHaveLength(1);
      const content = socketCalls[0].content as Record<string, unknown>;
      expect(content.document).toBeInstanceOf(Buffer);
      expect(content.fileName).toBe("report.pdf");
      expect(content.caption).toBe("the report");
    });

    test("caption on last file only for multiple files", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const files = [tmpFile("a.jpg"), tmpFile("b.png")];

      await bridge.sendReply(
        "whatsapp:group@g.us:group@g.us",
        "both pics",
        files,
      );

      expect(socketCalls).toHaveLength(2);
      expect(
        (socketCalls[0].content as Record<string, unknown>).caption,
      ).toBeUndefined();
      expect((socketCalls[1].content as Record<string, unknown>).caption).toBe(
        "both pics",
      );
    });

    test("falls back to postMessage if socket is undefined", async () => {
      const { adapter, postCalls } = createMockAdapter({ noSocket: true });
      const bridge = new WhatsAppBridge(adapter as never);
      const file = tmpFile("photo.jpg");

      await bridge.sendReply(
        "whatsapp:group@g.us:group@g.us",
        "fallback text",
        [file],
      );

      expect(postCalls).toHaveLength(1);
      expect(postCalls[0].text).toBe("fallback text");
    });

    test("skips unreadable files, continues with others", async () => {
      const { adapter, socketCalls } = createMockAdapter();
      const bridge = new WhatsAppBridge(adapter as never);
      const badFile: EgressFile = {
        path: "/nonexistent/file.jpg",
        filename: "file.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      };
      const goodFile = tmpFile("good.png");

      await bridge.sendReply("whatsapp:group@g.us:group@g.us", "mixed", [
        badFile,
        goodFile,
      ]);

      expect(socketCalls).toHaveLength(1);
      const content = socketCalls[0].content as Record<string, unknown>;
      expect(content.image).toBeInstanceOf(Buffer);
      expect(content.caption).toBe("mixed");
    });
  });
});
