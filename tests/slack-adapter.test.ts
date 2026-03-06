/**
 * Slack adapter tests.
 *
 * Handler and utility function tests (slackGroupId, isSlackDM, slackCallerId,
 * createSlackMessageHandler) have moved to tests/slack-bridge.test.ts and
 * tests/handler.test.ts as part of the PlatformBridge refactor.
 */
import { describe, expect, test } from "bun:test";

describe("slack adapter module", () => {
  test("module exists", async () => {
    const mod = await import("../src/adapters/slack.js");
    expect(mod).toBeDefined();
  });
});
