import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type {
  Group,
  GroupConfigEntry,
  GroupRole,
  MessageAttachment,
  ScheduledTask,
  StoredMessage,
} from "../types.js";

type GroupRow = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};
type MessageRow = {
  id: number;
  groupId: string;
  role: StoredMessage["role"];
  content: string;
  attachments: string | null;
  createdAt: number;
  updatedAt: number;
};

export class Db {
  private readonly db: Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_group_created
      ON messages(group_id, created_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        cron TEXT,
        at TEXT,
        prompt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        silent INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_next
      ON tasks(active, next_run_at);

      CREATE TABLE IF NOT EXISTS chat_state (
        group_id TEXT PRIMARY KEY,
        min_message_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_roles (
        group_id TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        granted_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, platform_user_id)
      );

      CREATE TABLE IF NOT EXISTS group_config (
        group_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, key)
      );

      CREATE TABLE IF NOT EXISTS extension_state (
        extension TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (extension, key)
      );
    `);

    // Migration: add attachments column to messages table
    this.addColumnIfNotExists("messages", "attachments", "TEXT");

    // Migration: add silent column to tasks table
    this.addColumnIfNotExists("tasks", "silent", "INTEGER NOT NULL DEFAULT 0");

    // Migration: add at column to tasks table for one-shot tasks
    this.addColumnIfNotExists("tasks", "at", "TEXT");

    // Note: For existing databases where cron was NOT NULL, SQLite allows NULL values
    // in columns declared NOT NULL when inserted via ALTER TABLE or when the column
    // constraint was removed from CREATE TABLE. New databases get the correct schema.
  }

  private addColumnIfNotExists(
    table: string,
    column: string,
    type: string,
  ): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  ensureGroup(groupId: string): Group {
    const now = Date.now();

    this.db
      .query(
        "INSERT OR IGNORE INTO groups(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(groupId, groupId, now, now);

    this.db
      .query("UPDATE groups SET updated_at = ? WHERE id = ?")
      .run(now, groupId);

    const row = this.db
      .query(
        "SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM groups WHERE id = ?",
      )
      .get(groupId) as GroupRow | null;

    if (!row) throw new Error(`Failed to load group ${groupId}`);
    return row;
  }

  listGroups(): Group[] {
    return this.db
      .query(
        "SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM groups ORDER BY created_at ASC",
      )
      .all() as Group[];
  }

  updateGroupTitle(groupId: string, title: string): boolean {
    const now = Date.now();
    const result = this.db
      .query("UPDATE groups SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now, groupId);
    return result.changes > 0;
  }

  getGroup(groupId: string): Group | null {
    return this.db
      .query(
        "SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM groups WHERE id = ?",
      )
      .get(groupId) as Group | null;
  }

  deleteGroup(groupId: string): {
    deleted: boolean;
    removed: {
      group: number;
      messages: number;
      tasks: number;
      chatState: number;
      roles: number;
      config: number;
    };
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const messages = this.db
        .query("DELETE FROM messages WHERE group_id = ?")
        .run(groupId).changes;
      const tasks = this.db
        .query("DELETE FROM tasks WHERE group_id = ?")
        .run(groupId).changes;
      const chatState = this.db
        .query("DELETE FROM chat_state WHERE group_id = ?")
        .run(groupId).changes;
      const roles = this.db
        .query("DELETE FROM group_roles WHERE group_id = ?")
        .run(groupId).changes;
      const config = this.db
        .query("DELETE FROM group_config WHERE group_id = ?")
        .run(groupId).changes;
      const group = this.db
        .query("DELETE FROM groups WHERE id = ?")
        .run(groupId).changes;

      this.db.exec("COMMIT");

      return {
        deleted: group > 0,
        removed: { group, messages, tasks, chatState, roles, config },
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  addMessage(
    groupId: string,
    role: StoredMessage["role"],
    content: string,
    attachments?: MessageAttachment[],
  ): void {
    const now = Date.now();
    const attachmentsJson =
      attachments && attachments.length > 0
        ? JSON.stringify(attachments)
        : null;
    this.db
      .query(
        "INSERT INTO messages(group_id, role, content, attachments, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(groupId, role, content, attachmentsJson, now, now);
  }

  clearMessages(groupId: string): void {
    this.db.query("DELETE FROM messages WHERE group_id = ?").run(groupId);
  }

  private getSessionBoundary(groupId: string): number {
    const row = this.db
      .query(
        "SELECT min_message_id as minMessageId FROM chat_state WHERE group_id = ?",
      )
      .get(groupId) as { minMessageId: number } | null;
    return row?.minMessageId ?? 0;
  }

  setSessionBoundaryToLatest(groupId: string): number {
    const row = this.db
      .query(
        "SELECT COALESCE(MAX(id), 0) as id FROM messages WHERE group_id = ?",
      )
      .get(groupId) as { id: number } | null;
    const minMessageId = Number(row?.id ?? 0);

    const now = Date.now();
    this.db
      .query(
        `INSERT INTO chat_state(group_id, min_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id)
         DO UPDATE SET min_message_id = excluded.min_message_id, updated_at = excluded.updated_at`,
      )
      .run(groupId, minMessageId, now, now);

    return minMessageId;
  }

  private parseMessageRow(row: MessageRow): StoredMessage {
    let attachments: MessageAttachment[] | undefined;
    if (row.attachments) {
      try {
        attachments = JSON.parse(row.attachments) as MessageAttachment[];
      } catch {
        attachments = undefined;
      }
    }
    return {
      id: row.id,
      groupId: row.groupId,
      role: row.role,
      content: row.content,
      attachments,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getRecentMessages(groupId: string, limit = 40): StoredMessage[] {
    const boundary = this.getSessionBoundary(groupId);
    const rows = this.db
      .query(
        `SELECT id, group_id as groupId, role, content, attachments, created_at as createdAt, updated_at as updatedAt
         FROM messages
         WHERE group_id = ? AND id > ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(groupId, boundary, limit) as MessageRow[];
    return rows.reverse().map((row) => this.parseMessageRow(row));
  }

  getMessagesSinceLastUserTrigger(
    groupId: string,
    limit = 200,
  ): StoredMessage[] {
    const boundary = this.getSessionBoundary(groupId);

    const latestUser = this.db
      .query(
        `SELECT id
         FROM messages
         WHERE group_id = ? AND role = 'user' AND id > ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(groupId, boundary) as { id: number } | null;

    if (!latestUser) return [];

    const previousUser = this.db
      .query(
        `SELECT id
         FROM messages
         WHERE group_id = ? AND role = 'user' AND id > ? AND id < ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(groupId, boundary, latestUser.id) as { id: number } | null;

    const afterId = previousUser?.id ?? boundary;

    const rows = this.db
      .query(
        `SELECT id, group_id as groupId, role, content, attachments, created_at as createdAt, updated_at as updatedAt
         FROM messages
         WHERE group_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(groupId, afterId, limit) as MessageRow[];
    return rows.map((row) => this.parseMessageRow(row));
  }

  createTask(
    groupId: string,
    schedule: { cron: string } | { at: string },
    prompt: string,
    nextRunAt: number,
    createdBy: string,
    silent = false,
  ): number {
    const now = Date.now();
    const cron = "cron" in schedule ? schedule.cron : null;
    const at = "at" in schedule ? schedule.at : null;
    this.db
      .query(
        "INSERT INTO tasks(group_id, cron, at, prompt, active, silent, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
      )
      .run(
        groupId,
        cron,
        at,
        prompt,
        silent ? 1 : 0,
        nextRunAt,
        createdBy,
        now,
        now,
      );

    const row = this.db.query("SELECT last_insert_rowid() as id").get() as {
      id: number;
    } | null;
    if (!row) throw new Error("Failed to read task id");
    return Number(row.id);
  }

  listTasks(groupId?: string): ScheduledTask[] {
    if (groupId) {
      return this.db
        .query(
          `SELECT id, group_id as groupId, cron, at, prompt, active, silent, next_run_at as nextRunAt, created_by as createdBy, created_at as createdAt, updated_at as updatedAt
           FROM tasks WHERE group_id = ? ORDER BY id ASC`,
        )
        .all(groupId) as ScheduledTask[];
    }

    return this.db
      .query(
        `SELECT id, group_id as groupId, cron, at, prompt, active, silent, next_run_at as nextRunAt, created_by as createdBy, created_at as createdAt, updated_at as updatedAt
         FROM tasks ORDER BY id ASC`,
      )
      .all() as ScheduledTask[];
  }

  getDueTasks(now = Date.now()): ScheduledTask[] {
    return this.db
      .query(
        `SELECT id, group_id as groupId, cron, at, prompt, active, silent, next_run_at as nextRunAt, created_by as createdBy, created_at as createdAt, updated_at as updatedAt
         FROM tasks
         WHERE active = 1 AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as ScheduledTask[];
  }

  updateTaskNextRun(id: number, nextRunAt: number): void {
    this.db
      .query("UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(nextRunAt, Date.now(), id);
  }

  setTaskActive(id: number, active: boolean): void {
    this.db
      .query("UPDATE tasks SET active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, Date.now(), id);
  }

  deleteTask(id: number, groupId: string): boolean {
    const result = this.db
      .query("DELETE FROM tasks WHERE id = ? AND group_id = ?")
      .run(id, groupId);
    return result.changes > 0;
  }

  deleteTaskById(id: number): boolean {
    const result = this.db.query("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getTask(id: number): ScheduledTask | null {
    return this.db
      .query(
        `SELECT id, group_id as groupId, cron, at, prompt, active, silent, next_run_at as nextRunAt, created_by as createdBy, created_at as createdAt, updated_at as updatedAt
         FROM tasks WHERE id = ?`,
      )
      .get(id) as ScheduledTask | null;
  }

  // --- Roles ---

  upsertMember(groupId: string, platformUserId: string): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT OR IGNORE INTO group_roles(group_id, platform_user_id, role, granted_by, created_at, updated_at)
         VALUES (?, ?, 'member', NULL, ?, ?)`,
      )
      .run(groupId, platformUserId, now, now);
  }

  setRole(
    groupId: string,
    platformUserId: string,
    role: string,
    grantedBy: string,
  ): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO group_roles(group_id, platform_user_id, role, granted_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, platform_user_id)
         DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
      )
      .run(groupId, platformUserId, role, grantedBy, now, now);
  }

  getRole(groupId: string, platformUserId: string): string | null {
    const row = this.db
      .query(
        "SELECT role FROM group_roles WHERE group_id = ? AND platform_user_id = ?",
      )
      .get(groupId, platformUserId) as { role: string } | null;
    return row?.role ?? null;
  }

  listRoles(groupId: string): GroupRole[] {
    return this.db
      .query(
        `SELECT group_id as groupId, platform_user_id as platformUserId, role, granted_by as grantedBy, created_at as createdAt, updated_at as updatedAt
         FROM group_roles WHERE group_id = ? ORDER BY created_at ASC`,
      )
      .all(groupId) as GroupRole[];
  }

  deleteRole(groupId: string, platformUserId: string): boolean {
    const result = this.db
      .query(
        `DELETE FROM group_roles WHERE group_id = ? AND platform_user_id = ?`,
      )
      .run(groupId, platformUserId);
    return result.changes > 0;
  }

  seedAdmins(groupId: string, adminIds: string[]): void {
    const now = Date.now();
    for (const id of adminIds) {
      this.db
        .query(
          `INSERT INTO group_roles(group_id, platform_user_id, role, granted_by, created_at, updated_at)
           VALUES (?, ?, 'admin', 'seed', ?, ?)
           ON CONFLICT(group_id, platform_user_id)
           DO UPDATE SET role = 'admin', granted_by = 'seed', updated_at = excluded.updated_at
           WHERE group_roles.role != 'admin'`,
        )
        .run(groupId, id, now, now);
    }
  }

  // --- Group Config ---

  getGroupConfig(groupId: string, key: string): string | null {
    const row = this.db
      .query("SELECT value FROM group_config WHERE group_id = ? AND key = ?")
      .get(groupId, key) as { value: string } | null;
    return row?.value ?? null;
  }

  setGroupConfig(
    groupId: string,
    key: string,
    value: string,
    updatedBy: string,
  ): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO group_config(group_id, key, value, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, key)
         DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(groupId, key, value, updatedBy, now, now);
  }

  // --- Extension State ---

  getExtState(extension: string, key: string): string | null {
    const row = this.db
      .query(
        "SELECT value FROM extension_state WHERE extension = ? AND key = ?",
      )
      .get(extension, key) as { value: string } | null;
    return row?.value ?? null;
  }

  setExtState(extension: string, key: string, value: string): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO extension_state(extension, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(extension, key)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(extension, key, value, now, now);
  }

  deleteExtState(extension: string, key: string): boolean {
    const result = this.db
      .query("DELETE FROM extension_state WHERE extension = ? AND key = ?")
      .run(extension, key);
    return result.changes > 0;
  }

  listExtState(extension: string): Array<{ key: string; value: string }> {
    return this.db
      .query(
        "SELECT key, value FROM extension_state WHERE extension = ? ORDER BY key ASC",
      )
      .all(extension) as Array<{ key: string; value: string }>;
  }

  close(): void {
    this.db.close();
  }

  listGroupConfig(groupId: string): GroupConfigEntry[] {
    return this.db
      .query(
        `SELECT group_id as groupId, key, value, updated_by as updatedBy, created_at as createdAt, updated_at as updatedAt
         FROM group_config WHERE group_id = ? ORDER BY key ASC`,
      )
      .all(groupId) as GroupConfigEntry[];
  }
}
