import { describe, expect, test } from "bun:test";
import { type Adapter, Message, parseMarkdown } from "chat";
import { createMessageHandler } from "../src/core/handler.js";
import type {
  ContainerResult,
  IngressMessage,
  NormalizeContext,
  PlatformBridge,
} from "../src/types.js";

// ─── Mock Bridge ────────────────────────────────────────────────────────

function mockBridge(
  overrides?: Partial<PlatformBridge> & {
    normalizeResult?: IngressMessage | null;
  },
): PlatformBridge & {
  replyCalls: { threadId: string; text: string; files?: unknown[] }[];
} {
  const replyCalls: { threadId: string; text: string; files?: unknown[] }[] =
    [];
  return {
    platform: "test",
    parseThread: (threadId) => ({ externalId: threadId, isDM: false }),
    normalize: async (_threadId, message, _ctx, spaceId) => {
      if ("normalizeResult" in (overrides ?? {})) {
        return overrides?.normalizeResult ?? null;
      }
      const msg = message as Message;
      return {
        platform: "test",
        spaceId,
        conversationExternalId: "test-thread",
        callerId: "test:user1",
        authorName: msg.author.userName,
        text: msg.text,
        isDM: false,
        isReplyToBot: false,
        attachments: [],
      };
    },
    sendReply: async (threadId, text, files) => {
      replyCalls.push({ threadId, text, files: files as unknown[] });
    },
    replyCalls,
    ...overrides,
  };
}

// ─── Mock Core Runtime ──────────────────────────────────────────────────

function mockCore(handleResult?: {
  type: string;
  reason?: string;
  result?: ContainerResult;
}) {
  const handleCalls: { message: IngressMessage; source: string }[] = [];
  return {
    core: {
      db: {
        getSpaceConfig: () => null,
        ensureConversation: (
          _platform: string,
          externalId: string,
          kind: string,
        ) => ({
          id: 1,
          platform: "test",
          externalId,
          kind,
          observedTitle: null,
          spaceId: "space1",
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
        }),
      },
      handleRawInput: async (message: IngressMessage, source: string) => {
        handleCalls.push({ message, source });
        return (
          handleResult ?? {
            type: "assistant",
            result: { reply: "bot response", files: [] },
          }
        );
      },
    },
    handleCalls,
  };
}

// ─── Mock Adapter ───────────────────────────────────────────────────────

function mockAdapter(name = "test") {
  const actions: string[] = [];
  return {
    adapter: {
      name,
      startTyping: async (_threadId: string) => {
        actions.push("typing");
      },
    } as unknown as Adapter,
    actions,
  };
}

function makeMessage(text: string, opts?: { isMe?: boolean }): Message {
  return new Message({
    id: "msg-1",
    threadId: "test-thread",
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: {
      userId: "user1",
      userName: "TestUser",
      fullName: "TestUser",
      isBot: false,
      isMe: opts?.isMe ?? false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
  });
}

const defaultConfig = {
  triggerPatterns: "@mercury",
  triggerMatch: "mention",
} as never;

const defaultCtx: NormalizeContext = {
  botUserName: "mercury",
  getWorkspace: () => "/tmp/test-workspace",
  media: { enabled: false, maxSizeBytes: 0 },
};

// ─── Tests ──────────────────────────────────────────────────────────────

describe("createMessageHandler", () => {
  test("skips bot own messages", async () => {
    const bridge = mockBridge();
    const { core } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("hello", { isMe: true });

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });

  test("skips empty messages", async () => {
    const bridge = mockBridge();
    const { core } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });

  test("skips when normalize returns null", async () => {
    const bridge = mockBridge({ normalizeResult: null });
    const { core } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("hello");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });

  test("triggered message → normalize → route → sendReply", async () => {
    const bridge = mockBridge();
    const { core, handleCalls } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter, actions } = mockAdapter();
    const msg = makeMessage("@mercury do something");

    await handler(adapter, "test-thread", msg);

    expect(actions).toContain("typing");
    expect(handleCalls).toHaveLength(1);
    expect(handleCalls[0].source).toBe("chat-sdk");
    expect(bridge.replyCalls).toHaveLength(1);
    expect(bridge.replyCalls[0].text).toBe("bot response");
  });

  test("ignored result → no reply", async () => {
    const bridge = mockBridge();
    const { core } = mockCore({ type: "ignore" });
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("@mercury hello");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });

  test("denied result → sendReply with reason", async () => {
    const bridge = mockBridge();
    const { core } = mockCore({ type: "denied", reason: "Rate limited" });
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("@mercury hello");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(1);
    expect(bridge.replyCalls[0].text).toBe("Rate limited");
  });

  test("result with files → sendReply includes files", async () => {
    const files = [
      {
        path: "/tmp/chart.png",
        filename: "chart.png",
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ];
    const bridge = mockBridge();
    const { core } = mockCore({
      type: "assistant",
      result: { reply: "here", files },
    });
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("@mercury chart");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(1);
    expect(bridge.replyCalls[0].files).toHaveLength(1);
  });

  test("empty reply with no files → no sendReply", async () => {
    const bridge = mockBridge();
    const { core } = mockCore({
      type: "assistant",
      result: { reply: "", files: [] },
    });
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("@mercury hello");

    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });

  test("reply-to-bot starts typing after normalize", async () => {
    const bridge = mockBridge({
      normalizeResult: {
        platform: "test",
        spaceId: "test-group",
        callerId: "test:user1",
        authorName: "User",
        text: "some reply",
        isDM: false,
        isReplyToBot: true,
        attachments: [],
      },
    });
    const { core } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter, actions } = mockAdapter();
    const msg = makeMessage("some reply");

    await handler(adapter, "test-thread", msg);

    expect(actions).toContain("typing");
    expect(bridge.replyCalls).toHaveLength(1);
  });

  test("does not crash on handler error", async () => {
    const bridge = mockBridge({
      normalize: async () => {
        throw new Error("normalize exploded");
      },
    });
    const { core } = mockCore();
    const handler = createMessageHandler({
      bridge,
      core: core as never,
      config: defaultConfig,
      ctx: defaultCtx,
    });
    const { adapter } = mockAdapter();
    const msg = makeMessage("@mercury hello");

    // Should not throw
    await handler(adapter, "test-thread", msg);

    expect(bridge.replyCalls).toHaveLength(0);
  });
});
