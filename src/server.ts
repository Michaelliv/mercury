import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "chat";
import { Hono } from "hono";
import type { WhatsAppBaileysAdapter } from "./adapters/whatsapp.js";
import type { AppConfig } from "./config.js";
import { createApiApp } from "./core/api.js";
import { createChatRoute } from "./core/routes/chat.js";
import { createDashboardRoutes } from "./core/routes/dashboard.js";
import type { MercuryCoreRuntime } from "./core/runtime.js";
import type { ConfigRegistry } from "./extensions/config-registry.js";
import type { ExtensionRegistry } from "./extensions/loader.js";
import type { MercuryExtensionContext } from "./extensions/types.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

type WaitUntil = (task: Promise<unknown>) => void;

type WebhookHandler = (
  request: Request,
  options?: { waitUntil?: WaitUntil },
) => Promise<Response>;

export interface ServerContext {
  core: MercuryCoreRuntime;
  config: AppConfig;
  adapters: Record<string, Adapter>;
  webhooks: Record<string, WebhookHandler>;
  startTime: number;
  registry: ExtensionRegistry;
  configRegistry: ConfigRegistry;
}

export function createApp(ctx: ServerContext): Hono {
  const { core, config, adapters, webhooks, startTime } = ctx;

  const waitUntil: WaitUntil = (task) => {
    void task.catch((error) => {
      logger.error(
        "Background task failed",
        error instanceof Error ? error : undefined,
      );
    });
  };

  const app = new Hono();

  // ─── Dashboard ──────────────────────────────────────────────────────────

  app.get("/", (c) => {
    try {
      const html = readFileSync(
        join(__dirname, "dashboard/index.html"),
        "utf8",
      );
      return c.html(html);
    } catch {
      return c.text("Dashboard not found", 404);
    }
  });

  app.get("/dashboard", (c) => {
    try {
      const html = readFileSync(
        join(__dirname, "dashboard/index.html"),
        "utf8",
      );
      return c.html(html);
    } catch {
      return c.text("Dashboard not found", 404);
    }
  });

  // Dashboard partials (htmx)
  const adapterStatus: Record<string, boolean> = {};
  for (const name of Object.keys(adapters)) {
    adapterStatus[name] = true;
  }

  const dashboardRoutes = createDashboardRoutes({
    core,
    adapters: adapterStatus,
    startTime,
    registry: ctx.registry,
    extensionCtx: {
      db: core.db,
      config,
      log: logger,
    },
  });

  app.route("/dashboard", dashboardRoutes);

  // ─── Health & Auth ──────────────────────────────────────────────────────

  app.get("/health", (c) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const adapterStatus: Record<string, boolean> = {};
    for (const name of Object.keys(adapters)) {
      adapterStatus[name] = true;
    }
    return c.json({
      status: "ok",
      uptime: uptimeSeconds,
      queue: {
        active: core.queue.activeCount,
        pending: core.queue.pendingCount,
      },
      containers: {
        active: core.containerRunner.activeCount,
      },
      adapters: adapterStatus,
    });
  });

  app.get("/auth/whatsapp", (c) => {
    const whatsappAdapter = adapters.whatsapp as
      | WhatsAppBaileysAdapter
      | undefined;
    if (!whatsappAdapter) {
      return c.json({ error: "WhatsApp adapter not enabled" }, 400);
    }
    const status = whatsappAdapter.getQrStatus();
    return c.json(status);
  });

  // ─── Internal API ───────────────────────────────────────────────────────

  const apiApp = createApiApp({
    db: core.db,
    config,
    containerRunner: core.containerRunner,
    queue: core.queue,
    scheduler: core.scheduler,
    registry: ctx.registry,
    configRegistry: ctx.configRegistry,
  });

  app.route("/api", apiApp);
  app.route("/chat", createChatRoute(core));

  // ─── Webhooks ───────────────────────────────────────────────────────────

  app.all("/webhooks/:platform", async (c) => {
    const platform = c.req.param("platform");
    logger.info("Webhook dispatch", { platform });

    const handler = webhooks[platform];
    if (!handler) {
      return c.text(`Unknown platform: ${platform}`, 404);
    }

    return handler(c.req.raw, { waitUntil });
  });

  // ─── Fallback ───────────────────────────────────────────────────────────

  app.all("*", (c) => {
    return c.text("Not found", 404);
  });

  return app;
}
