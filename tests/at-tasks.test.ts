import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskScheduler } from "../src/core/task-scheduler.js";
import { Db } from "../src/storage/db.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-at-tasks-test-"));
  db = new Db(path.join(tmpDir, "state.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("at-tasks database", () => {
  test("createTask with at schedule", () => {
    db.ensureGroup("g1");
    const atTime = new Date(Date.now() + 60000).toISOString();
    const id = db.createTask(
      "g1",
      { at: atTime },
      "one-shot task",
      Date.now() + 60000,
      "user1",
    );
    expect(id).toBeGreaterThan(0);

    const task = db.getTask(id);
    expect(task).not.toBeNull();
    expect(task?.at).toBe(atTime);
    expect(task?.cron).toBeNull();
    expect(task?.prompt).toBe("one-shot task");
  });

  test("createTask with cron schedule still works", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { cron: "*/5 * * * *" },
      "recurring task",
      Date.now() + 60000,
      "user1",
    );

    const task = db.getTask(id);
    expect(task).not.toBeNull();
    expect(task?.cron).toBe("*/5 * * * *");
    expect(task?.at).toBeNull();
  });

  test("listTasks includes at field", () => {
    db.ensureGroup("g1");
    const atTime = new Date(Date.now() + 60000).toISOString();
    db.createTask("g1", { at: atTime }, "at-task", Date.now() + 60000, "user1");
    db.createTask(
      "g1",
      { cron: "* * * * *" },
      "cron-task",
      Date.now() + 60000,
      "user1",
    );

    const tasks = db.listTasks("g1");
    expect(tasks.length).toBe(2);

    const atTask = tasks.find((t) => t.prompt === "at-task");
    const cronTask = tasks.find((t) => t.prompt === "cron-task");

    expect(atTask?.at).toBe(atTime);
    expect(atTask?.cron).toBeNull();
    expect(cronTask?.cron).toBe("* * * * *");
    expect(cronTask?.at).toBeNull();
  });

  test("getDueTasks includes at-tasks", () => {
    db.ensureGroup("g1");
    const now = Date.now();
    const atTime = new Date(now - 1000).toISOString();
    db.createTask("g1", { at: atTime }, "due at-task", now - 1000, "user1");

    const due = db.getDueTasks(now);
    expect(due.length).toBe(1);
    expect(due[0].at).toBe(atTime);
    expect(due[0].prompt).toBe("due at-task");
  });

  test("deleteTaskById removes task without groupId", () => {
    db.ensureGroup("g1");
    const id = db.createTask(
      "g1",
      { at: new Date(Date.now() + 60000).toISOString() },
      "task",
      Date.now() + 60000,
      "user1",
    );

    expect(db.deleteTaskById(id)).toBe(true);
    expect(db.getTask(id)).toBeNull();
  });

  test("deleteTaskById returns false for missing task", () => {
    expect(db.deleteTaskById(999)).toBe(false);
  });

  test("at-task respects active flag", () => {
    db.ensureGroup("g1");
    const now = Date.now();
    const id = db.createTask(
      "g1",
      { at: new Date(now - 1000).toISOString() },
      "paused at-task",
      now - 1000,
      "user1",
    );

    db.setTaskActive(id, false);
    expect(db.getDueTasks(now).length).toBe(0);

    db.setTaskActive(id, true);
    expect(db.getDueTasks(now).length).toBe(1);
  });

  test("at-task with silent flag", () => {
    db.ensureGroup("g1");
    const atTime = new Date(Date.now() + 60000).toISOString();
    const id = db.createTask(
      "g1",
      { at: atTime },
      "silent at-task",
      Date.now() + 60000,
      "user1",
      true,
    );

    const task = db.getTask(id);
    expect(task?.silent).toBe(1);
  });
});

describe("at-tasks scheduler", () => {
  test("scheduler deletes at-task after execution", async () => {
    db.ensureGroup("g1");
    const now = Date.now();
    const atTime = new Date(now - 1000).toISOString();
    const taskId = db.createTask(
      "g1",
      { at: atTime },
      "one-shot",
      now - 1000,
      "user1",
    );

    const executed: number[] = [];
    const scheduler = new TaskScheduler(db, 100);

    scheduler.start(async (task) => {
      executed.push(task.id);
    });

    // Wait for scheduler to process
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    // Task should have been executed
    expect(executed).toContain(taskId);

    // Task should be deleted
    expect(db.getTask(taskId)).toBeNull();
  });

  test("scheduler keeps cron-task after execution", async () => {
    db.ensureGroup("g1");
    const now = Date.now();
    const taskId = db.createTask(
      "g1",
      { cron: "* * * * *" },
      "recurring",
      now - 1000,
      "user1",
    );

    const executed: number[] = [];
    const scheduler = new TaskScheduler(db, 100);

    scheduler.start(async (task) => {
      executed.push(task.id);
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    // Task should have been executed
    expect(executed).toContain(taskId);

    // Task should still exist with updated nextRunAt
    const task = db.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.nextRunAt).toBeGreaterThan(now);
  });

  test("at-task deleted even if handler throws", async () => {
    db.ensureGroup("g1");
    const now = Date.now();
    const atTime = new Date(now - 1000).toISOString();
    const taskId = db.createTask(
      "g1",
      { at: atTime },
      "failing task",
      now - 1000,
      "user1",
    );

    const scheduler = new TaskScheduler(db, 100);

    scheduler.start(async () => {
      throw new Error("Handler failed");
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    // Task should still be deleted even though handler failed
    expect(db.getTask(taskId)).toBeNull();
  });
});
