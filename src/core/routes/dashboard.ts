import { Hono } from "hono";
import { html, raw } from "hono/html";
import { streamSSE } from "hono/streaming";
import type { MercuryCoreRuntime } from "../runtime.js";

interface DashboardContext {
  core: MercuryCoreRuntime;
  adapters: Record<string, boolean>;
  startTime: number;
}

type HealthStatus = "healthy" | "degraded" | "critical";

export function createDashboardRoutes(ctx: DashboardContext) {
  const { core, adapters, startTime } = ctx;
  const app = new Hono();

  // ─── Helpers ────────────────────────────────────────────────────────────

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    if (seconds > 10) return `${seconds}s ago`;
    return "just now";
  }

  function formatFutureTime(timestamp: number): string {
    const now = Date.now();
    const diff = timestamp - now;
    if (diff < 0) return "now";

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `in ${days}d`;
    if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `in ${minutes}m`;
    return `in ${seconds}s`;
  }

  function escapeHtml(str: string): string {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncate(str: string, len = 40): string {
    if (!str) return "—";
    return str.length > len ? `${str.slice(0, len)}...` : str;
  }

  function getSystemHealth(): {
    status: HealthStatus;
    message: string;
    lastError: string | null;
  } {
    const adapterEntries = Object.entries(adapters);
    const disconnected = adapterEntries.filter(([, connected]) => !connected);
    const queueBacklog = core.queue.pendingCount > 10;

    // TODO: Track actual errors in the system
    const lastError = null;

    if (
      disconnected.length === adapterEntries.length &&
      adapterEntries.length > 0
    ) {
      return {
        status: "critical",
        message: "All adapters disconnected",
        lastError,
      };
    }

    if (queueBacklog) {
      return {
        status: "critical",
        message: `Queue backing up (${core.queue.pendingCount} pending)`,
        lastError,
      };
    }

    if (disconnected.length > 0) {
      return {
        status: "degraded",
        message: `${disconnected.map(([n]) => n).join(", ")} disconnected`,
        lastError,
      };
    }

    return {
      status: "healthy",
      message: "All systems operational",
      lastError,
    };
  }

  // ─── Page Routes (htmx content swapping) ────────────────────────────────

  // Middleware: redirect direct browser access to main dashboard
  app.use("/page/*", async (c, next) => {
    const isHtmx = c.req.header("HX-Request") === "true";
    if (!isHtmx) {
      // Direct browser access - redirect to dashboard with the page in hash
      const path = c.req.path.replace("/dashboard/page/", "");
      return c.redirect(`/dashboard#${path}`);
    }
    return next();
  });

  app.get("/page/overview", (c) => {
    const activeGroups = core.containerRunner.getActiveGroups();
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    // Active runs
    const activeRunsHtml =
      activeGroups.length > 0
        ? activeGroups
            .map((g) => {
              const platform = g.split(":")[0];
              const shortId = g.length > 30 ? `...${g.slice(-20)}` : g;
              return `
              <div class="active-run">
                <span class="badge">${platform}</span>
                <span class="mono">${escapeHtml(shortId)}</span>
                <span class="status active">running</span>
                <button class="btn btn-sm btn-danger" 
                        hx-post="/dashboard/api/stop" 
                        hx-headers='{"X-Mercury-Group": "${escapeHtml(g)}", "X-Mercury-Caller": "dashboard"}'
                        hx-swap="none">Stop</button>
              </div>
            `;
            })
            .join("")
        : '<div class="empty-small">No active runs</div>';

    // Adapters
    const adapterEntries = Object.entries(adapters);
    const adaptersHtml = adapterEntries
      .map(([name, connected]) => {
        const status = connected ? "connected" : "disconnected";
        const icon = connected ? "🟢" : "🔴";
        return `
          <div class="adapter-row">
            <span>${icon} ${name}</span>
            <span class="muted">${status}</span>
          </div>
        `;
      })
      .join("");

    // Recent activity
    const groups = core.db.listGroups();
    const activity: Array<{
      groupId: string;
      platform: string;
      role: string;
      preview: string;
      time: number;
    }> = [];

    for (const g of groups.slice(0, 5)) {
      const msgs = core.db.getRecentMessages(g.id, 3);
      const platform = g.id.split(":")[0];
      for (const m of msgs) {
        activity.push({
          groupId: g.id,
          platform,
          role: m.role,
          preview: m.content.slice(0, 60),
          time: m.createdAt,
        });
      }
    }
    activity.sort((a, b) => b.time - a.time);

    const activityHtml =
      activity.length > 0
        ? activity
            .slice(0, 8)
            .map(
              (a) => `
              <div class="activity-row" 
                   hx-get="/dashboard/page/groups/${encodeURIComponent(a.groupId)}" 
                   hx-target="#main" 
                   hx-push-url="true">
                <span class="time">${formatRelativeTime(a.time)}</span>
                <span class="badge">${a.platform}</span>
                <span class="role ${a.role}">${a.role}</span>
                <span class="preview">${escapeHtml(a.preview)}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No recent activity</div>';

    // Upcoming tasks
    const tasks = core.db.listTasks().filter((t) => t.active);
    const upcomingHtml =
      tasks.length > 0
        ? tasks
            .slice(0, 3)
            .map(
              (t) => `
              <div class="task-row">
                <span class="mono">#${t.id}</span>
                <span class="truncate">${escapeHtml(truncate(t.prompt, 25))}</span>
                <span class="muted">${formatFutureTime(t.nextRunAt)}</span>
                <button class="btn btn-sm" 
                        hx-post="/dashboard/api/tasks/${t.id}/run" 
                        hx-swap="none"
                        title="Run now">▶</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No scheduled tasks</div>';

    return c.html(html`
      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Adapters</div>
          <div class="panel-body">${raw(adaptersHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">
            Active Work
            <span class="badge">${activeGroups.length}</span>
          </div>
          <div class="panel-body">${raw(activeRunsHtml)}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          Recent Activity
          <a href="#" hx-get="/dashboard/page/logs" hx-target="#main" hx-push-url="true" class="link">View logs →</a>
        </div>
        <div class="panel-body">${raw(activityHtml)}</div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">
            Upcoming Tasks
            <a href="#" hx-get="/dashboard/page/tasks" hx-target="#main" hx-push-url="true" class="link">View all →</a>
          </div>
          <div class="panel-body">${raw(upcomingHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Stats</div>
          <div class="panel-body stats">
            <div class="stat">
              <div class="stat-value">${groups.length}</div>
              <div class="stat-label">Groups</div>
            </div>
            <div class="stat">
              <div class="stat-value">${core.queue.pendingCount}</div>
              <div class="stat-label">Queued</div>
            </div>
            <div class="stat">
              <div class="stat-value">${formatUptime(uptimeSeconds)}</div>
              <div class="stat-label">Uptime</div>
            </div>
          </div>
        </div>
      </div>
    `);
  });

  app.get("/page/groups", (c) => {
    const groups = core.db
      .listGroups()
      .map((g) => {
        const parts = g.id.split(":");
        const platform = parts[0];
        const msgCount = core.db.getRecentMessages(g.id, 1000).length;

        return {
          id: g.id,
          platform,
          title: g.title !== g.id ? g.title : null,
          lastActivity: g.updatedAt,
          messageCount: msgCount,
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);

    const rowsHtml =
      groups.length > 0
        ? groups
            .map(
              (g) => `
              <tr class="clickable" 
                  hx-get="/dashboard/page/groups/${encodeURIComponent(g.id)}" 
                  hx-target="#main" 
                  hx-push-url="true">
                <td><span class="badge">${g.platform}</span></td>
                <td class="mono">${escapeHtml(g.title || truncate(g.id, 30))}</td>
                <td class="muted">${formatRelativeTime(g.lastActivity)}</td>
                <td class="muted">${g.messageCount}</td>
                <td>
                  <button class="btn btn-sm" title="Settings">⚙</button>
                </td>
              </tr>
            `,
            )
            .join("")
        : '<tr><td colspan="5" class="empty">No groups yet</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Groups</h2>
        <div class="search-box">
          <input type="text" placeholder="Search groups..." id="group-search"
                 onkeyup="filterTable(this, 'groups-table')" />
        </div>
      </div>

      <div class="panel">
        <table class="table" id="groups-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Name</th>
              <th>Last Active</th>
              <th>Messages</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${raw(rowsHtml)}</tbody>
        </table>
      </div>
    `);
  });

  app.get("/page/groups/:id", (c) => {
    const groupId = decodeURIComponent(c.req.param("id"));
    const group = core.db.listGroups().find((g) => g.id === groupId);

    if (!group) {
      return c.html(html`
        <div class="page-header">
          <a href="#" hx-get="/dashboard/page/groups" hx-target="#main" hx-push-url="true" class="back">← Back</a>
          <h2>Group not found</h2>
        </div>
        <div class="panel">
          <div class="panel-body empty">Group "${escapeHtml(groupId)}" not found</div>
        </div>
      `);
    }

    const platform = groupId.split(":")[0];
    const messages = core.db.getRecentMessages(groupId, 50);
    const roles = core.db.listRoles(groupId);
    const tasks = core.db.listTasks().filter((t) => t.groupId === groupId);

    const messagesHtml =
      messages.length > 0
        ? messages
            .map(
              (m) => `
              <div class="message ${m.role}">
                <div class="message-meta">
                  <span class="role ${m.role}">${m.role}</span>
                  <span class="time">${formatRelativeTime(m.createdAt)}</span>
                </div>
                <div class="message-content">${escapeHtml(m.content)}</div>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No messages yet</div>';

    const rolesHtml =
      roles.length > 0
        ? roles
            .map(
              (r) => `
              <div class="role-row">
                <span class="mono">${escapeHtml(r.platformUserId)}</span>
                <span class="badge ${r.role === "admin" ? "green" : ""}">${r.role}</span>
                <button class="btn btn-sm btn-danger" 
                        hx-delete="/dashboard/api/roles?groupId=${encodeURIComponent(groupId)}&platformUserId=${encodeURIComponent(r.platformUserId)}"
                        hx-swap="none"
                        hx-confirm="Remove role for ${escapeHtml(r.platformUserId)}?">✕</button>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No roles assigned</div>';

    const tasksHtml =
      tasks.length > 0
        ? tasks
            .map(
              (t) => `
              <div class="task-row">
                <span class="mono">#${t.id}</span>
                <span>${escapeHtml(truncate(t.prompt, 30))}</span>
                <span class="badge ${t.active ? "green" : ""}">${t.active ? "active" : "paused"}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty-small">No tasks for this group</div>';

    return c.html(html`
      <div class="page-header">
        <a href="#" hx-get="/dashboard/page/groups" hx-target="#main" hx-push-url="true" class="back">← Back</a>
        <h2>
          <span class="badge">${platform}</span>
          ${escapeHtml(group.title !== group.id ? group.title : truncate(groupId, 40))}
        </h2>
      </div>

      <div class="grid-2">
        <div class="panel">
          <div class="panel-header">Roles</div>
          <div class="panel-body">${raw(rolesHtml)}</div>
        </div>
        <div class="panel">
          <div class="panel-header">Tasks</div>
          <div class="panel-body">${raw(tasksHtml)}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">Recent Messages</div>
        <div class="panel-body messages-list">${raw(messagesHtml)}</div>
      </div>
    `);
  });

  app.get("/page/tasks", (c) => {
    const tasks = core.db.listTasks();

    const rowsHtml =
      tasks.length > 0
        ? tasks
            .map(
              (t) => `
              <tr>
                <td class="mono">#${t.id}</td>
                <td class="mono">${escapeHtml(t.cron || "one-shot")}</td>
                <td class="truncate" title="${escapeHtml(t.prompt)}">${escapeHtml(truncate(t.prompt, 40))}</td>
                <td class="muted">${formatFutureTime(t.nextRunAt)}</td>
                <td><span class="badge ${t.active ? "green" : ""}">${t.active ? "active" : "paused"}</span></td>
                <td class="actions">
                  <button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/run" hx-swap="none" title="Run now">▶</button>
                  ${
                    t.active
                      ? `<button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/pause" hx-swap="none" title="Pause">⏸</button>`
                      : `<button class="btn btn-sm" hx-post="/dashboard/api/tasks/${t.id}/resume" hx-swap="none" title="Resume">▶️</button>`
                  }
                  <button class="btn btn-sm btn-danger" hx-delete="/dashboard/api/tasks/${t.id}" hx-swap="none" hx-confirm="Delete task #${t.id}?" title="Delete">✕</button>
                </td>
              </tr>
            `,
            )
            .join("")
        : '<tr><td colspan="6" class="empty">No scheduled tasks</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Scheduled Tasks</h2>
      </div>

      <div class="panel">
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Schedule</th>
              <th>Prompt</th>
              <th>Next Run</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${raw(rowsHtml)}</tbody>
        </table>
      </div>
    `);
  });

  app.get("/page/permissions", (c) => {
    const groups = core.db.listGroups();
    const allRoles: Array<{
      groupId: string;
      platform: string;
      userId: string;
      role: string;
    }> = [];

    for (const g of groups) {
      const platform = g.id.split(":")[0];
      const groupRoles = core.db.listRoles(g.id);
      for (const r of groupRoles) {
        allRoles.push({
          groupId: g.id,
          platform,
          userId: r.platformUserId,
          role: r.role,
        });
      }
    }

    const rowsHtml =
      allRoles.length > 0
        ? allRoles
            .map(
              (r) => `
              <tr>
                <td><span class="badge">${r.platform}</span></td>
                <td class="mono truncate" title="${escapeHtml(r.groupId)}">${escapeHtml(truncate(r.groupId, 25))}</td>
                <td class="mono">${escapeHtml(r.userId)}</td>
                <td><span class="badge ${r.role === "admin" ? "green" : ""}">${r.role}</span></td>
                <td>
                  <button class="btn btn-sm btn-danger" 
                          hx-delete="/dashboard/api/roles?groupId=${encodeURIComponent(r.groupId)}&platformUserId=${encodeURIComponent(r.userId)}"
                          hx-swap="none"
                          hx-confirm="Remove ${r.role} role for ${escapeHtml(r.userId)}?">✕</button>
                </td>
              </tr>
            `,
            )
            .join("")
        : '<tr><td colspan="5" class="empty">No roles assigned</td></tr>';

    return c.html(html`
      <div class="page-header">
        <h2>Permissions</h2>
      </div>

      <div class="panel">
        <table class="table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Group</th>
              <th>User</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${raw(rowsHtml)}</tbody>
        </table>
      </div>
    `);
  });

  app.get("/page/logs", (c) => {
    // Aggregate recent messages as "logs" for now
    // In a real system, you'd have a proper log store
    const groups = core.db.listGroups();
    const logs: Array<{
      time: number;
      level: string;
      source: string;
      message: string;
      groupId?: string;
    }> = [];

    // Add message events as logs
    for (const g of groups) {
      const msgs = core.db.getRecentMessages(g.id, 10);
      const platform = g.id.split(":")[0];
      for (const m of msgs) {
        logs.push({
          time: m.createdAt,
          level: "INFO",
          source: platform,
          message: `${m.role}: ${m.content.slice(0, 80)}`,
          groupId: g.id,
        });
      }
    }

    logs.sort((a, b) => b.time - a.time);

    const logsHtml =
      logs.length > 0
        ? logs
            .slice(0, 50)
            .map(
              (l) => `
              <div class="log-row ${l.level.toLowerCase()}">
                <span class="time">${new Date(l.time).toLocaleTimeString()}</span>
                <span class="level ${l.level.toLowerCase()}">${l.level}</span>
                <span class="source">${l.source}</span>
                <span class="message">${escapeHtml(l.message)}</span>
              </div>
            `,
            )
            .join("")
        : '<div class="empty">No logs available</div>';

    return c.html(html`
      <div class="page-header">
        <h2>Logs</h2>
        <div class="filters">
          <select class="select" onchange="filterLogs(this)">
            <option value="all">All levels</option>
            <option value="error">Errors only</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      <div class="panel">
        <div class="panel-body logs-list">${raw(logsHtml)}</div>
      </div>
    `);
  });

  // ─── SSE Stream ─────────────────────────────────────────────────────────

  app.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      const sendEvent = async (event: string, data: string) => {
        await stream.writeSSE({ event, data: data.replace(/\n/g, "") });
      };

      const renderHealth = () => {
        const health = getSystemHealth();
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const icon =
          health.status === "healthy"
            ? "🟢"
            : health.status === "degraded"
              ? "🟡"
              : "🔴";
        const lastError = health.lastError
          ? `Last error: ${health.lastError}`
          : "";

        return `
          <div class="health-status ${health.status}">
            <span class="health-icon">${icon}</span>
            <span class="health-message">${health.message}</span>
          </div>
          <div class="health-meta">
            <span class="uptime">up ${formatUptime(uptimeSeconds)}</span>
            ${lastError ? `<span class="last-error">${lastError}</span>` : ""}
          </div>
        `;
      };

      const renderActiveCount = () => {
        const count = core.containerRunner.activeCount;
        return count > 0
          ? `<span class="badge pulse">${count} running</span>`
          : "";
      };

      // Send initial state
      await sendEvent("health", renderHealth());
      await sendEvent("active-count", renderActiveCount());

      // Update loop
      let running = true;
      let lastActiveCount = core.containerRunner.activeCount;

      stream.onAbort(() => {
        running = false;
      });

      while (running) {
        await stream.sleep(1000);

        // Always update health (includes uptime)
        await sendEvent("health", renderHealth());

        // Update active count only on change
        const currentActiveCount = core.containerRunner.activeCount;
        if (currentActiveCount !== lastActiveCount) {
          await sendEvent("active-count", renderActiveCount());
          lastActiveCount = currentActiveCount;
        }
      }
    });
  });

  // ─── Dashboard Actions (no auth required, admin-only UI) ────────────────

  app.post("/api/tasks/:id/run", async (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const triggered = await core.scheduler.triggerTask(taskId);
    if (!triggered) {
      return c.json({ error: "Task not found or inactive" }, 400);
    }

    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/pause", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    core.db.setTaskActive(taskId, false);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/resume", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    core.db.setTaskActive(taskId, true);
    return c.json({ ok: true });
  });

  app.delete("/api/tasks/:id", (c) => {
    const taskId = Number.parseInt(c.req.param("id"), 10);
    const task = core.db.listTasks().find((t) => t.id === taskId);

    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    const deleted = core.db.deleteTask(taskId, task.groupId);
    if (!deleted) {
      return c.json({ error: "Failed to delete task" }, 500);
    }

    return c.json({ ok: true });
  });

  app.delete("/api/roles", (c) => {
    const groupId = c.req.query("groupId");
    const platformUserId = c.req.query("platformUserId");

    if (!groupId || !platformUserId) {
      return c.json({ error: "Missing groupId or platformUserId" }, 400);
    }

    core.db.deleteRole(groupId, platformUserId);
    return c.json({ ok: true });
  });

  app.post("/api/stop", (c) => {
    const groupId = c.req.header("X-Mercury-Group");

    if (!groupId) {
      return c.json({ error: "Missing X-Mercury-Group header" }, 400);
    }

    core.containerRunner.abort(groupId);
    return c.json({ ok: true });
  });

  return app;
}
