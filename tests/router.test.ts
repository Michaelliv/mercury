import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AppConfig, loadConfig } from "../src/config.js";
import { seededGroups } from "../src/core/permissions.js";
import { type RouteResult, routeInput } from "../src/core/router.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;
let config: AppConfig;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
  config = {
    ...loadConfig(),
    admins: "admin1",
    triggerPatterns: "@Pi,Pi",
    triggerMatch: "mention",
  };
  seededGroups.clear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function route(
  overrides: Partial<Parameters<typeof routeInput>[0]> = {},
): RouteResult {
  return routeInput({
    rawText: "@Pi hello",
    groupId: "g1",
    callerId: "admin1",
    isDM: false,
    db,
    config,
    ...overrides,
  });
}

describe("routeInput — trigger matching", () => {
  test("matches @Pi trigger in group", () => {
    const r = route({ rawText: "@Pi hello world" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello world");
    }
  });

  test("matches Pi trigger in group", () => {
    const r = route({ rawText: "Pi what time is it" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("what time is it");
    }
  });

  test("ignores message without trigger in group", () => {
    const r = route({ rawText: "hello everyone" });
    expect(r.type).toBe("ignore");
  });

  test("DM always matches even without trigger", () => {
    const r = route({ rawText: "hello", isDM: true });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("DM strips trigger when present", () => {
    const r = route({ rawText: "@Pi hello", isDM: true });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("empty text is ignored", () => {
    const r = route({ rawText: "" });
    expect(r.type).toBe("ignore");
  });

  test("whitespace-only text is ignored", () => {
    const r = route({ rawText: "   " });
    expect(r.type).toBe("ignore");
  });
});

describe("routeInput — role resolution", () => {
  test("admin gets admin role", () => {
    const r = route({ callerId: "admin1" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("admin");
    }
  });

  test("unknown user gets member role", () => {
    const r = route({ rawText: "@Pi hello", callerId: "user99" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("member");
    }
  });

  test("system caller gets system role", () => {
    const r = route({ callerId: "system" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.role).toBe("system");
    }
  });
});

describe("routeInput — permission gating", () => {
  test("member with prompt permission can use assistant", () => {
    const r = route({ callerId: "user1" });
    expect(r.type).toBe("assistant");
  });

  test("member without prompt permission is denied", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "role.member.permissions", "stop", "system");

    const r = route({ callerId: "user1" });
    expect(r.type).toBe("denied");
  });
});

describe("routeInput — chat commands", () => {
  test("admin can execute stop command", () => {
    const r = route({ rawText: "@Pi stop" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("stop");
    }
  });

  test("admin can execute compact command", () => {
    const r = route({ rawText: "@Pi compact" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("compact");
    }
  });

  test("member cannot execute stop command", () => {
    const r = route({ rawText: "@Pi stop", callerId: "user1" });
    expect(r.type).toBe("denied");
  });

  test("member with stop permission can execute stop", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "role.member.permissions", "prompt,stop", "system");

    const r = route({ rawText: "@Pi stop", callerId: "user1" });
    expect(r.type).toBe("command");
    if (r.type === "command") {
      expect(r.command).toBe("stop");
    }
  });

  test("command requires trigger (not just 'stop' in group)", () => {
    const r = route({ rawText: "stop" });
    expect(r.type).toBe("ignore");
  });

  test("command works in DM without trigger", () => {
    const r = route({ rawText: "stop", callerId: "admin1", isDM: true });
    expect(r.type).toBe("command");
  });

  test("partial command match goes to assistant, not command", () => {
    const r = route({ rawText: "@Pi stop all" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("stop all");
    }
  });
});

describe("routeInput — edge cases", () => {
  test("trigger-only message in group routes to assistant", () => {
    const r = route({ rawText: "@Pi" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("@Pi");
    }
  });
});

describe("routeInput — per-group trigger config", () => {
  test("per-group trigger pattern override", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "trigger.patterns", "Hey Bot", "system");

    const r = route({ rawText: "Hey Bot do stuff" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("do stuff");
    }
  });

  test("per-group trigger mode override to always", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "trigger.match", "always", "system");

    const r = route({ rawText: "random message no trigger" });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("random message no trigger");
    }
  });

  test("per-group trigger mode override to prefix", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "trigger.match", "prefix", "system");

    // @Pi at start works
    const r1 = route({ rawText: "@Pi hello" });
    expect(r1.type).toBe("assistant");

    // @Pi in middle fails
    const r2 = route({ rawText: "hey @Pi hello" });
    expect(r2.type).toBe("ignore");
  });
});

describe("routeInput — reply-to-bot behavior", () => {
  test("reply to bot triggers response without explicit mention", () => {
    const r = route({
      rawText: "what about tomorrow?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("what about tomorrow?");
    }
  });

  test("reply to bot uses full text (no trigger stripping)", () => {
    const r = route({
      rawText: "can you explain more?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("can you explain more?");
    }
  });

  test("reply to bot in DM does not double-trigger", () => {
    // DMs already auto-trigger, so reply flag shouldn't change behavior
    const r = route({
      rawText: "hello",
      isDM: true,
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      expect(r.prompt).toBe("hello");
    }
  });

  test("non-reply without trigger is ignored", () => {
    const r = route({
      rawText: "random message",
      isReplyToBot: false,
      callerId: "user1",
    });
    expect(r.type).toBe("ignore");
  });

  test("reply to bot with trigger present strips trigger", () => {
    // If user replies AND includes trigger, trigger stripping should work
    const r = route({
      rawText: "@Pi what about tomorrow?",
      isReplyToBot: true,
      callerId: "user1",
    });
    expect(r.type).toBe("assistant");
    if (r.type === "assistant") {
      // Trigger matched, so prompt is stripped
      expect(r.prompt).toBe("what about tomorrow?");
    }
  });
});
