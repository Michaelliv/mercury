import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MercuryCoreRuntime } from "../src/core/runtime.js";

describe("Runtime rate limiting", () => {
  let tempDir: string;
  let runtime: MercuryCoreRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-rate-test-"));

    runtime = new MercuryCoreRuntime({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-20250514",
      triggerPatterns: "@Pi,Pi",
      triggerMatch: "mention",
      dataDir: tempDir,
      authPath: undefined,
      agentContainerImage: "test",
      containerTimeoutMs: 60000,
      maxConcurrency: 2,
      rateLimitPerUser: 3, // 3 requests per window
      rateLimitWindowMs: 60000,
      chatSdkPort: 8787,
      chatSdkUserName: "mercury",
      discordGatewayDurationMs: 600000,
      discordGatewaySecret: undefined,
      enableWhatsApp: false,
      admins: "",
      dbPath: path.join(tempDir, "state.db"),
      globalDir: path.join(tempDir, "global"),
      groupsDir: path.join(tempDir, "groups"),
      whatsappAuthDir: path.join(tempDir, "whatsapp-auth"),
    });

    // Mock the container runner to avoid actual container execution
    runtime.containerRunner.reply = mock(async () => "mocked reply");
  });

  afterEach(() => {
    runtime.rateLimiter.stopCleanup();
    runtime.db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("allows requests under rate limit", async () => {
    const message = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Should allow 3 requests
    const r1 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r3.type).toBe("assistant");
  });

  test("blocks requests over rate limit", async () => {
    const message = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up the limit
    await runtime.handleRawInput(message, "chat-sdk");
    await runtime.handleRawInput(message, "chat-sdk");
    await runtime.handleRawInput(message, "chat-sdk");

    // Fourth request should be denied
    const r4 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r4.type).toBe("denied");
    expect(r4.reason).toBe("Rate limit exceeded. Try again shortly.");
  });

  test("different users have separate rate limits", async () => {
    const user1Message = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const user2Message = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "user2",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up user1's limit
    await runtime.handleRawInput(user1Message, "chat-sdk");
    await runtime.handleRawInput(user1Message, "chat-sdk");
    await runtime.handleRawInput(user1Message, "chat-sdk");

    const r4 = await runtime.handleRawInput(user1Message, "chat-sdk");
    expect(r4.type).toBe("denied");

    // user2 should still be allowed
    const r5 = await runtime.handleRawInput(user2Message, "chat-sdk");
    expect(r5.type).toBe("assistant");
  });

  test("commands bypass rate limit", async () => {
    // Seed admin so stop command is allowed
    runtime.db.ensureGroup("test-group");
    runtime.db.setRole("test-group", "admin1", "admin", "test");

    const promptMessage = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "admin1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const stopMessage = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi stop",
      callerId: "admin1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Use up the limit with prompts
    await runtime.handleRawInput(promptMessage, "chat-sdk");
    await runtime.handleRawInput(promptMessage, "chat-sdk");
    await runtime.handleRawInput(promptMessage, "chat-sdk");

    // Next prompt should be rate limited
    const r4 = await runtime.handleRawInput(promptMessage, "chat-sdk");
    expect(r4.type).toBe("denied");

    // But stop command should still work
    const stopResult = await runtime.handleRawInput(stopMessage, "chat-sdk");
    expect(stopResult.type).toBe("command");
  });

  test("per-group rate limit override", async () => {
    const message = {
      platform: "test",
      groupId: "limited-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Set a lower limit for this group
    runtime.db.ensureGroup("limited-group");
    runtime.db.setGroupConfig("limited-group", "rate_limit", "1", "test");

    // First request should be allowed
    const r1 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r1.type).toBe("assistant");

    // Second request should be denied (limit is 1)
    const r2 = await runtime.handleRawInput(message, "chat-sdk");
    expect(r2.type).toBe("denied");
    expect(r2.reason).toBe("Rate limit exceeded. Try again shortly.");
  });

  test("ignored messages don't count toward rate limit", async () => {
    const ignoredMessage = {
      platform: "test",
      groupId: "test-group",
      text: "just a regular message without trigger",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    const triggeredMessage = {
      platform: "test",
      groupId: "test-group",
      text: "@Pi hello",
      callerId: "user1",
      isDM: false,
      isReplyToBot: false,
      attachments: [],
    };

    // Send many ignored messages
    for (let i = 0; i < 10; i++) {
      const result = await runtime.handleRawInput(ignoredMessage, "chat-sdk");
      expect(result.type).toBe("ignore");
    }

    // Triggered messages should still be allowed (limit is 3)
    const r1 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r1.type).toBe("assistant");

    const r2 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r2.type).toBe("assistant");

    const r3 = await runtime.handleRawInput(triggeredMessage, "chat-sdk");
    expect(r3.type).toBe("assistant");
  });
});
