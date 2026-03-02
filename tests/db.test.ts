import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("groups", () => {
  test("ensureGroup creates and returns group", () => {
    const g = db.ensureGroup("g1");
    expect(g.id).toBe("g1");
    expect(g.title).toBe("g1");
    expect(g.createdAt).toBeGreaterThan(0);
    expect(g.updatedAt).toBeGreaterThan(0);
  });

  test("ensureGroup is idempotent", () => {
    const g1 = db.ensureGroup("g1");
    const g2 = db.ensureGroup("g1");
    expect(g1.id).toBe(g2.id);
  });

  test("listGroups returns all groups", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    const groups = db.listGroups();
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.id)).toEqual(["g1", "g2"]);
  });
});

describe("messages", () => {
  test("addMessage and getRecentMessages", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "hello");
    db.addMessage("g1", "assistant", "hi there");

    const msgs = db.getRecentMessages("g1");
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("hi there");
  });

  test("getRecentMessages respects limit", () => {
    db.ensureGroup("g1");
    for (let i = 0; i < 10; i++) {
      db.addMessage("g1", "user", `msg ${i}`);
    }

    const msgs = db.getRecentMessages("g1", 3);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("msg 7");
    expect(msgs[2].content).toBe("msg 9");
  });

  test("clearMessages removes all messages", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "hello");
    db.clearMessages("g1");
    expect(db.getRecentMessages("g1").length).toBe(0);
  });

  test("session boundary filters old messages", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "old message");
    db.setSessionBoundaryToLatest("g1");
    db.addMessage("g1", "user", "new message");

    const msgs = db.getRecentMessages("g1");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("new message");
  });

  test("messages are isolated between groups", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    db.addMessage("g1", "user", "g1 message");
    db.addMessage("g2", "user", "g2 message");

    expect(db.getRecentMessages("g1").length).toBe(1);
    expect(db.getRecentMessages("g1")[0].content).toBe("g1 message");
  });

  test("addMessage stores and retrieves attachments", () => {
    db.ensureGroup("g1");
    const attachments = [
      {
        path: "/groups/g1/media/123-image.jpg",
        type: "image" as const,
        mimeType: "image/jpeg",
        sizeBytes: 12345,
      },
    ];
    db.addMessage("g1", "user", "check this out", attachments);

    const msgs = db.getRecentMessages("g1");
    expect(msgs.length).toBe(1);
    expect(msgs[0].attachments).toBeDefined();
    expect(msgs[0].attachments?.length).toBe(1);
    expect(msgs[0].attachments?.[0].path).toBe(
      "/groups/g1/media/123-image.jpg",
    );
    expect(msgs[0].attachments?.[0].type).toBe("image");
    expect(msgs[0].attachments?.[0].mimeType).toBe("image/jpeg");
    expect(msgs[0].attachments?.[0].sizeBytes).toBe(12345);
  });

  test("messages without attachments have undefined attachments", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "plain text");

    const msgs = db.getRecentMessages("g1");
    expect(msgs[0].attachments).toBeUndefined();
  });
});

describe("tasks", () => {
  test("createTask and listTasks", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "*/5 * * * *" },
      "check stuff",
      Date.now() + 60000,
      "user1",
    );
    expect(id).toBeGreaterThan(0);

    const tasks = db.listTasks("g1");
    expect(tasks.length).toBe(1);
    expect(tasks[0].cron).toBe("*/5 * * * *");
    expect(tasks[0].at).toBeNull();
    expect(tasks[0].prompt).toBe("check stuff");
    expect(tasks[0].createdBy).toBe("user1");
    expect(tasks[0].active).toBe(1);
  });

  test("getDueTasks returns only due tasks", () => {
    db.ensureGroup("g1");
    const now = Date.now();
    db.createTask("g1", { cron: "* * * * *" }, "due", now - 1000, "user1");
    db.createTask("g1", { cron: "* * * * *" }, "not due", now + 60000, "user1");

    const due = db.getDueTasks(now);
    expect(due.length).toBe(1);
    expect(due[0].prompt).toBe("due");
  });

  test("setTaskActive pauses/resumes task", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      Date.now() - 1000,
      "user1",
    );

    db.setTaskActive(id, false);
    expect(db.getDueTasks().length).toBe(0);

    db.setTaskActive(id, true);
    expect(db.getDueTasks().length).toBe(1);
  });

  test("deleteTask removes task", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      Date.now(),
      "user1",
    );

    expect(db.deleteTask(id, "g1")).toBe(true);
    expect(db.listTasks("g1").length).toBe(0);
  });

  test("deleteTask fails for wrong group", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      Date.now(),
      "user1",
    );

    expect(db.deleteTask(id, "g2")).toBe(false);
    expect(db.listTasks("g1").length).toBe(1);
  });

  test("getTask returns task by id", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      Date.now(),
      "user1",
    );

    const task = db.getTask(id);
    expect(task).not.toBeNull();
    expect(task?.id).toBe(id);
    expect(task?.prompt).toBe("task");
  });

  test("getTask returns null for missing id", () => {
    expect(db.getTask(999)).toBeNull();
  });

  test("updateTaskNextRun updates next_run_at", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      1000,
      "user1",
    );

    db.updateTaskNextRun(id, 2000);
    const task = db.getTask(id);
    expect(task?.nextRunAt).toBe(2000);
  });

  test("createTask with silent flag", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "silent task",
      Date.now(),
      "user1",
      true,
    );

    const task = db.getTask(id);
    expect(task?.silent).toBe(1);
  });

  test("createTask defaults to not silent", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "task",
      Date.now(),
      "user1",
    );

    const task = db.getTask(id);
    expect(task?.silent).toBe(0);
  });

  test("listTasks includes silent field", () => {
    db.ensureGroup("g1");
    db.createTask(
      "g1",
      { cron: "* * * * *" },
      "normal",
      Date.now(),
      "user1",
      false,
    );
    db.createTask(
      "g1",
      { cron: "* * * * *" },
      "silent",
      Date.now(),
      "user1",
      true,
    );

    const tasks = db.listTasks("g1");
    expect(tasks.length).toBe(2);
    expect(tasks[0].silent).toBe(0);
    expect(tasks[1].silent).toBe(1);
  });

  test("getDueTasks includes silent field", () => {
    db.ensureGroup("g1");
    const now = Date.now();
    db.createTask(
      "g1",
      { cron: "* * * * *" },
      "silent due",
      now - 1000,
      "user1",
      true,
    );

    const due = db.getDueTasks(now);
    expect(due.length).toBe(1);
    expect(due[0].silent).toBe(1);
  });
});

describe("roles", () => {
  test("upsertMember creates member role", () => {
    db.ensureGroup("g1");
    db.upsertMember("g1", "user1");

    expect(db.getRole("g1", "user1")).toBe("member");
  });

  test("upsertMember does not overwrite existing role", () => {
    db.ensureGroup("g1");
    db.setRole("g1", "user1", "admin", "system");
    db.upsertMember("g1", "user1");

    expect(db.getRole("g1", "user1")).toBe("admin");
  });

  test("setRole creates or updates role", () => {
    db.ensureGroup("g1");
    db.setRole("g1", "user1", "admin", "system");
    expect(db.getRole("g1", "user1")).toBe("admin");

    db.setRole("g1", "user1", "moderator", "admin1");
    expect(db.getRole("g1", "user1")).toBe("moderator");
  });

  test("getRole returns null for unknown user", () => {
    db.ensureGroup("g1");
    expect(db.getRole("g1", "unknown")).toBeNull();
  });

  test("listRoles returns all roles for group", () => {
    db.ensureGroup("g1");
    db.setRole("g1", "user1", "admin", "system");
    db.setRole("g1", "user2", "member", "system");

    const roles = db.listRoles("g1");
    expect(roles.length).toBe(2);
  });

  test("seedAdmins grants admin to listed users", () => {
    db.ensureGroup("g1");
    db.seedAdmins("g1", ["user1", "user2"]);

    expect(db.getRole("g1", "user1")).toBe("admin");
    expect(db.getRole("g1", "user2")).toBe("admin");
  });

  test("seedAdmins does not downgrade existing admin", () => {
    db.ensureGroup("g1");
    db.setRole("g1", "user1", "admin", "manual");
    db.seedAdmins("g1", ["user1"]);

    expect(db.getRole("g1", "user1")).toBe("admin");
  });

  test("roles are isolated between groups", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    db.setRole("g1", "user1", "admin", "system");

    expect(db.getRole("g1", "user1")).toBe("admin");
    expect(db.getRole("g2", "user1")).toBeNull();
  });
});

describe("group config", () => {
  test("getGroupConfig returns null for missing key", () => {
    db.ensureGroup("g1");
    expect(db.getGroupConfig("g1", "missing")).toBeNull();
  });

  test("setGroupConfig and getGroupConfig", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "trigger.match", "always", "admin1");

    expect(db.getGroupConfig("g1", "trigger.match")).toBe("always");
  });

  test("setGroupConfig overwrites existing value", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "key", "val1", "admin1");
    db.setGroupConfig("g1", "key", "val2", "admin2");

    expect(db.getGroupConfig("g1", "key")).toBe("val2");
  });

  test("listGroupConfig returns all config entries", () => {
    db.ensureGroup("g1");
    db.setGroupConfig("g1", "a", "1", "admin");
    db.setGroupConfig("g1", "b", "2", "admin");

    const entries = db.listGroupConfig("g1");
    expect(entries.length).toBe(2);
    expect(entries[0].key).toBe("a");
    expect(entries[1].key).toBe("b");
  });

  test("config is isolated between groups", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    db.setGroupConfig("g1", "key", "g1val", "admin");
    db.setGroupConfig("g2", "key", "g2val", "admin");

    expect(db.getGroupConfig("g1", "key")).toBe("g1val");
    expect(db.getGroupConfig("g2", "key")).toBe("g2val");
  });
});

describe("tasks — listTasks without groupId", () => {
  test("returns all tasks across groups", () => {
    db.ensureGroup("g1");
    db.ensureGroup("g2");
    db.createTask("g1", { cron: "* * * * *" }, "task1", Date.now(), "user1");
    db.createTask("g2", { cron: "* * * * *" }, "task2", Date.now(), "user2");

    const all = db.listTasks();
    expect(all.length).toBe(2);
    expect(all[0].prompt).toBe("task1");
    expect(all[1].prompt).toBe("task2");
  });
});

describe("getMessagesSinceLastUserTrigger", () => {
  test("returns messages between last two user messages", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "first question");
    db.addMessage("g1", "assistant", "first answer");
    db.addMessage("g1", "user", "second question");
    db.addMessage("g1", "assistant", "second answer");

    const msgs = db.getMessagesSinceLastUserTrigger("g1");
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("first answer");
    expect(msgs[1].content).toBe("second question");
    expect(msgs[2].content).toBe("second answer");
  });

  test("returns empty if no user messages", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "assistant", "unsolicited");

    const msgs = db.getMessagesSinceLastUserTrigger("g1");
    expect(msgs.length).toBe(0);
  });

  test("respects session boundary", () => {
    db.ensureGroup("g1");
    db.addMessage("g1", "user", "old");
    db.addMessage("g1", "assistant", "old response");
    db.setSessionBoundaryToLatest("g1");
    db.addMessage("g1", "user", "new");
    db.addMessage("g1", "assistant", "new response");

    const msgs = db.getMessagesSinceLastUserTrigger("g1");
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("new");
  });
});
