import { CronExpressionParser } from "cron-parser";
import type { AgentContainerRunner } from "../agent/container-runner.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";
import type { GroupQueue } from "./group-queue.js";
import {
  ALL_PERMISSIONS,
  getRolePermissions,
  hasPermission,
  type Permission,
  resolveRole,
} from "./permissions.js";
import type { TaskScheduler } from "./task-scheduler.js";

interface ApiContext {
  db: Db;
  config: AppConfig;
  containerRunner: AgentContainerRunner;
  queue: GroupQueue;
  scheduler: TaskScheduler;
}

interface TaskCreateBody {
  cron?: string;
  at?: string; // ISO 8601 timestamp for one-shot tasks
  prompt?: string;
  silent?: boolean;
}

interface ConfigSetBody {
  key?: string;
  value?: string;
}

interface RoleGrantBody {
  platformUserId?: string;
  role?: string;
}

interface PermissionsSetBody {
  role?: string;
  permissions?: string[];
}

async function parseBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

function parseCallerHeaders(
  request: Request,
): { callerId: string; groupId: string } | null {
  const callerId = request.headers.get("x-mercury-caller");
  const groupId = request.headers.get("x-mercury-group");
  if (!callerId || !groupId) return null;
  return { callerId, groupId };
}

function check(
  db: Db,
  groupId: string,
  role: string,
  permission: Permission,
): Response | null {
  if (!hasPermission(db, groupId, role, permission)) {
    return error(`Forbidden: requires '${permission}' permission`, 403);
  }
  return null;
}

export function handleApiRequest(
  request: Request,
  url: URL,
  ctx: ApiContext,
): Response | Promise<Response> {
  const path = url.pathname;

  const caller = parseCallerHeaders(request);
  if (!caller) {
    return error("Missing X-Mercury-Caller or X-Mercury-Group headers", 400);
  }

  const { callerId, groupId } = caller;
  const seededAdmins = ctx.config.admins
    ? ctx.config.admins
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  ctx.db.ensureGroup(groupId);
  const role = resolveRole(ctx.db, groupId, callerId, seededAdmins);

  // --- whoami ---
  if (path === "/api/whoami" && request.method === "GET") {
    const permissions = [...getRolePermissions(ctx.db, groupId, role)];
    return json({ callerId, groupId, role, permissions });
  }

  // --- tasks ---
  if (path === "/api/tasks" && request.method === "GET") {
    const denied = check(ctx.db, groupId, role, "tasks.list");
    if (denied) return denied;
    const tasks = ctx.db.listTasks(groupId);
    return json({ tasks });
  }

  if (path === "/api/tasks" && request.method === "POST") {
    const denied = check(ctx.db, groupId, role, "tasks.create");
    if (denied) return denied;
    return (async () => {
      const body = await parseBody<TaskCreateBody>(request);
      if (!body) return error("Invalid JSON body", 400);
      if (!body.prompt) return error("Missing prompt", 400);
      if (!body.cron && !body.at) return error("Missing cron or at", 400);
      if (body.cron && body.at)
        return error("Cannot specify both cron and at", 400);

      const silent = body.silent ?? false;
      let nextRunAt: number;
      let schedule: { cron: string } | { at: string };

      if (body.cron) {
        try {
          const interval = CronExpressionParser.parse(body.cron, {
            currentDate: new Date(),
          });
          nextRunAt = interval.next().getTime();
          schedule = { cron: body.cron };
        } catch {
          return error("Invalid cron expression", 400);
        }
      } else {
        const atStr = body.at as string; // Safe: validated above (!body.cron && !body.at)
        const atTime = new Date(atStr).getTime();
        if (Number.isNaN(atTime)) return error("Invalid at timestamp", 400);
        if (atTime <= Date.now())
          return error("at timestamp must be in the future", 400);
        nextRunAt = atTime;
        schedule = { at: atStr };
      }

      const id = ctx.db.createTask(
        groupId,
        schedule,
        body.prompt,
        nextRunAt,
        callerId,
        silent,
      );

      return json({
        id,
        cron: body.cron ?? null,
        at: body.at ?? null,
        prompt: body.prompt,
        silent,
        nextRunAt,
      });
    })();
  }

  const taskMatch = path.match(/^\/api\/tasks\/(\d+)(\/(\w+))?$/);
  if (taskMatch) {
    const taskId = Number(taskMatch[1]);
    if (!Number.isFinite(taskId) || taskId < 1) {
      return error("Invalid task ID", 400);
    }
    const action = taskMatch[3];

    if (action === "pause" && request.method === "POST") {
      const denied = check(ctx.db, groupId, role, "tasks.pause");
      if (denied) return denied;
      const task = ctx.db.getTask(taskId);
      if (!task || task.groupId !== groupId)
        return error("Task not found", 404);
      ctx.db.setTaskActive(taskId, false);
      return json({ id: taskId, active: false });
    }

    if (action === "resume" && request.method === "POST") {
      const denied = check(ctx.db, groupId, role, "tasks.resume");
      if (denied) return denied;
      const task = ctx.db.getTask(taskId);
      if (!task || task.groupId !== groupId)
        return error("Task not found", 404);
      ctx.db.setTaskActive(taskId, true);
      return json({ id: taskId, active: true });
    }

    if (action === "run" && request.method === "POST") {
      const denied = check(ctx.db, groupId, role, "tasks.create");
      if (denied) return denied;
      const task = ctx.db.getTask(taskId);
      if (!task || task.groupId !== groupId)
        return error("Task not found", 404);
      if (!task.active) return error("Task is paused", 400);
      // Trigger async - don't wait for completion
      ctx.scheduler.triggerTask(taskId).catch((err) => {
        logger.error("Task trigger failed", { taskId, error: String(err) });
      });
      return json({ id: taskId, triggered: true });
    }

    if (!action && request.method === "DELETE") {
      const denied = check(ctx.db, groupId, role, "tasks.delete");
      if (denied) return denied;
      const deleted = ctx.db.deleteTask(taskId, groupId);
      if (!deleted) return error("Task not found", 404);
      return json({ id: taskId, deleted: true });
    }
  }

  // --- config ---
  if (path === "/api/config" && request.method === "GET") {
    const denied = check(ctx.db, groupId, role, "config.get");
    if (denied) return denied;
    const entries = ctx.db.listGroupConfig(groupId);
    const config: Record<string, string> = {};
    for (const e of entries) config[e.key] = e.value;
    return json({ groupId, config });
  }

  if (path === "/api/config" && request.method === "PUT") {
    const denied = check(ctx.db, groupId, role, "config.set");
    if (denied) return denied;
    return (async () => {
      const body = await parseBody<ConfigSetBody>(request);
      if (!body) return error("Invalid JSON body", 400);
      if (!body.key || body.value === undefined)
        return error("Missing key or value", 400);

      const validKeys = [
        "trigger.match",
        "trigger.patterns",
        "trigger.case_sensitive",
      ];
      if (!validKeys.includes(body.key))
        return error(`Invalid config key. Valid: ${validKeys.join(", ")}`, 400);

      if (
        body.key === "trigger.match" &&
        !["prefix", "mention", "always"].includes(body.value)
      ) {
        return error(
          "Invalid trigger.match value. Valid: prefix, mention, always",
          400,
        );
      }
      if (
        body.key === "trigger.case_sensitive" &&
        !["true", "false"].includes(body.value)
      ) {
        return error(
          "Invalid trigger.case_sensitive value. Valid: true, false",
          400,
        );
      }

      ctx.db.setGroupConfig(groupId, body.key, body.value, callerId);
      return json({ groupId, key: body.key, value: body.value });
    })();
  }

  // --- roles ---
  if (path === "/api/roles" && request.method === "GET") {
    const denied = check(ctx.db, groupId, role, "roles.list");
    if (denied) return denied;
    const roles = ctx.db.listRoles(groupId);
    return json({ roles });
  }

  if (path === "/api/roles" && request.method === "POST") {
    const denied = check(ctx.db, groupId, role, "roles.grant");
    if (denied) return denied;
    return (async () => {
      const body = await parseBody<RoleGrantBody>(request);
      if (!body) return error("Invalid JSON body", 400);
      if (!body.platformUserId) return error("Missing platformUserId", 400);
      const targetRole = body.role ?? "admin";
      ctx.db.setRole(groupId, body.platformUserId, targetRole, callerId);
      return json({
        groupId,
        platformUserId: body.platformUserId,
        role: targetRole,
      });
    })();
  }

  const roleMatch = path.match(/^\/api\/roles\/(.+)$/);
  if (roleMatch && request.method === "DELETE") {
    const denied = check(ctx.db, groupId, role, "roles.revoke");
    if (denied) return denied;
    const targetUserId = decodeURIComponent(roleMatch[1]);
    ctx.db.setRole(groupId, targetUserId, "member", callerId);
    return json({ groupId, platformUserId: targetUserId, role: "member" });
  }

  // --- permissions ---
  if (path === "/api/permissions" && request.method === "GET") {
    const denied = check(ctx.db, groupId, role, "permissions.get");
    if (denied) return denied;
    const targetRole = url.searchParams.get("role");
    if (targetRole) {
      const perms = [...getRolePermissions(ctx.db, groupId, targetRole)];
      return json({ groupId, role: targetRole, permissions: perms });
    }
    // Return all known roles' permissions
    const allRoles: Record<string, string[]> = {};
    for (const r of ["admin", "member"]) {
      allRoles[r] = [...getRolePermissions(ctx.db, groupId, r)];
    }
    // Also include any custom roles from group_roles table
    const groupRoles = ctx.db.listRoles(groupId);
    const roleNames = new Set(groupRoles.map((r) => r.role));
    for (const r of roleNames) {
      if (!allRoles[r]) {
        allRoles[r] = [...getRolePermissions(ctx.db, groupId, r)];
      }
    }
    return json({ groupId, permissions: allRoles, available: ALL_PERMISSIONS });
  }

  if (path === "/api/permissions" && request.method === "PUT") {
    const denied = check(ctx.db, groupId, role, "permissions.set");
    if (denied) return denied;
    return (async () => {
      const body = await parseBody<PermissionsSetBody>(request);
      if (!body) return error("Invalid JSON body", 400);
      if (!body.role || !Array.isArray(body.permissions)) {
        return error("Missing role or permissions array", 400);
      }
      const invalid = body.permissions.filter(
        (p) => !ALL_PERMISSIONS.includes(p as Permission),
      );
      if (invalid.length > 0) {
        return error(
          `Invalid permissions: ${invalid.join(", ")}. Valid: ${ALL_PERMISSIONS.join(", ")}`,
          400,
        );
      }
      const key = `role.${body.role}.permissions`;
      ctx.db.setGroupConfig(groupId, key, body.permissions.join(","), callerId);
      return json({ groupId, role: body.role, permissions: body.permissions });
    })();
  }

  // --- stop ---
  if (path === "/api/stop" && request.method === "POST") {
    const denied = check(ctx.db, groupId, role, "stop");
    if (denied) return denied;
    const stopped = ctx.containerRunner.abort(groupId);
    const dropped = ctx.queue.cancelPending(groupId);
    return json({ stopped, dropped });
  }

  // --- compact ---
  if (path === "/api/compact" && request.method === "POST") {
    const denied = check(ctx.db, groupId, role, "compact");
    if (denied) return denied;
    const boundary = ctx.db.setSessionBoundaryToLatest(groupId);
    return json({ groupId, boundary });
  }

  // --- groups ---
  if (path === "/api/groups" && request.method === "GET") {
    const denied = check(ctx.db, groupId, role, "groups.list");
    if (denied) return denied;
    const groups = ctx.db.listGroups();
    return json({ groups });
  }

  if (path === "/api/groups/current" && request.method === "GET") {
    const group = ctx.db.getGroup(groupId);
    if (!group) return error("Group not found", 404);
    return json({ group });
  }

  if (path === "/api/groups/current/name" && request.method === "PUT") {
    const denied = check(ctx.db, groupId, role, "groups.rename");
    if (denied) return denied;
    return (async () => {
      const body = await parseBody<{ name?: string }>(request);
      if (!body) return error("Invalid JSON body", 400);
      if (!body.name) return error("Missing name", 400);
      const updated = ctx.db.updateGroupTitle(groupId, body.name);
      if (!updated) return error("Group not found", 404);
      return json({ groupId, name: body.name });
    })();
  }

  return error("Not found", 404);
}
