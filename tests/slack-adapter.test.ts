import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSlackMessageHandler,
  isSlackDM,
  slackCallerId,
  slackGroupId,
} from "../src/adapters/slack.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-slack-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
  seededGroups.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: slackGroupId
// ---------------------------------------------------------------------------

describe("slackGroupId", () => {
  test("extracts channel from thread ID", () => {
    expect(slackGroupId("slack:C1234567890:1234567890.123456")).toBe(
      "slack:C1234567890",
    );
  });

  test("handles thread ID with no thread_ts", () => {
    expect(slackGroupId("slack:C1234567890")).toBe("slack:C1234567890");
  });

  test("handles DM channel", () => {
    expect(slackGroupId("slack:D9876543210:1234567890.123456")).toBe(
      "slack:D9876543210",
    );
  });

  test("falls back to full ID for unknown format", () => {
    expect(slackGroupId("something-else")).toBe("something-else");
  });
});

// ---------------------------------------------------------------------------
// Unit: isSlackDM
// ---------------------------------------------------------------------------

describe("isSlackDM", () => {
  test("returns true for DM channels (D prefix)", () => {
    expect(isSlackDM("slack:D1234567890:ts")).toBe(true);
  });

  test("returns false for public channels (C prefix)", () => {
    expect(isSlackDM("slack:C1234567890:ts")).toBe(false);
  });

  test("returns true for group DMs / MPDMs (G prefix)", () => {
    expect(isSlackDM("slack:G1234567890:ts")).toBe(true);
  });

  test("returns false for unknown format", () => {
    expect(isSlackDM("something-else")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: slackCallerId
// ---------------------------------------------------------------------------

describe("slackCallerId", () => {
  test("prefixes userId with slack:", () => {
    const msg = fakeMessage({ userId: "U123ABC" });
    expect(slackCallerId(msg)).toBe("slack:U123ABC");
  });

  test("handles missing userId", () => {
    const msg = fakeMessage({ userId: "" });
    // slackCallerId uses author.userId which defaults to "unknown" when empty
    // via the || "unknown" fallback in the function
    expect(slackCallerId(msg)).toBe("slack:unknown");
  });
});

// ---------------------------------------------------------------------------
// Integration: createSlackMessageHandler
// ---------------------------------------------------------------------------

describe("createSlackMessageHandler", () => {
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
    // Mock handleRawInput to return an assistant reply
    core.handleRawInput = mock(async () => ({
      type: "assistant" as const,
      prompt: "hello",
      callerId: "slack:U123",
      role: "member",
      result: { reply: "Hi there!", files: [] },
    }));

    const msg = fakeMessage({ text: "@Pi hello", userId: "U123" });
    await handler(thread, msg, true);

    expect(core.handleRawInput).toHaveBeenCalledTimes(1);
    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    expect(call.groupId).toBe("slack:C999");
    expect(call.callerId).toBe("slack:U123");
    expect(call.isDM).toBe(false);
    // Source is now the second argument
    const source = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][1];
    expect(source).toBe("chat-sdk");

    expect(thread.post).toHaveBeenCalledWith("Hi there!");
    expect(thread.subscribe).toHaveBeenCalled();
    expect(thread.startTyping).toHaveBeenCalled();
  });

  test("stores ambient messages for non-triggered group messages", async () => {
    const { handler, thread, core } = setup();
    // handleRawInput returns "ignore" for non-triggered messages
    // (the real runtime stores ambient messages internally)
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
    const dmThread = fakeThread("slack:D999:1234.5678");
    core.handleRawInput = mock(async () => ({
      type: "assistant" as const,
      prompt: "hello",
      callerId: "slack:U123",
      role: "member",
      result: { reply: "Hi from DM!", files: [] },
    }));

    const msg = fakeMessage({ text: "hello", userId: "U123" });
    await handler(dmThread, msg, true);

    const call = (core.handleRawInput as ReturnType<typeof mock>).mock
      .calls[0][0];
    expect(call.groupId).toBe("slack:D999");
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
      callerId: "slack:U123",
      role: "admin",
      result: { reply: "Stopped.", files: [] },
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
        callerId: "slack:U123",
        role: "member",
        result: { reply: "Hi!", files: [] },
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

function fakeThread(threadId = "slack:C999:1234567890.123456"): unknown {
  return {
    id: threadId,
    isDM: /^[DG]/.test(threadId.split(":")[1] ?? ""),
    adapter: { name: "slack" },
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

  const handler = createSlackMessageHandler({ core, db, config });
  const thread = fakeThread();

  return { handler, thread, core };
}
