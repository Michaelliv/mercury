import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { type Adapter, Chat, type Message, type Thread } from "chat";
import { createDiscordMessageHandler } from "./adapters/discord.js";
import { createDiscordNativeAdapter } from "./adapters/discord-native.js";
import { createSlackMessageHandler } from "./adapters/slack.js";
import {
  createWhatsAppBaileysAdapter,
  type WhatsAppBaileysAdapter,
} from "./adapters/whatsapp.js";
import { loadConfig, resolveProjectPath } from "./config.js";
import { handleApiRequest } from "./core/api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { MercuryCoreRuntime } from "./core/runtime.js";
import { loadTriggerConfig, matchTrigger } from "./core/trigger.js";
import { configureLogger, logger } from "./logger.js";
import { ensureGroupWorkspace } from "./storage/memory.js";

const startTime = Date.now();

type WaitUntil = (task: Promise<unknown>) => void;

type WebhookHandler = (
  request: Request,
  options?: { waitUntil?: WaitUntil },
) => Promise<Response>;

function resolveCallerId(message: Message, thread: Thread): string {
  const userId = message.author.userId || "unknown";
  const platform = thread.adapter.name;
  return `${platform}:${userId}`;
}

async function main() {
  const config = loadConfig();

  // Apply config-based logger settings
  configureLogger({
    level: config.logLevel,
    format: config.logFormat,
  });

  const core = new MercuryCoreRuntime(config);
  await core.initialize();

  const adapters: Record<string, Adapter> = {};

  if (config.enableSlack) {
    if (!process.env.SLACK_SIGNING_SECRET) {
      throw new Error(
        "MERCURY_ENABLE_SLACK=true but SLACK_SIGNING_SECRET is not set",
      );
    }
    adapters.slack = createSlackAdapter();
  }

  if (config.enableDiscord) {
    if (!process.env.DISCORD_BOT_TOKEN) {
      throw new Error(
        "MERCURY_ENABLE_DISCORD=true but DISCORD_BOT_TOKEN is not set",
      );
    }
    adapters.discord = createDiscordNativeAdapter({
      userName: config.chatSdkUserName,
    });
  }

  if (config.enableWhatsApp) {
    adapters.whatsapp = createWhatsAppBaileysAdapter({
      userName: config.chatSdkUserName,
      authDir: resolveProjectPath(config.whatsappAuthDir),
      mediaEnabled: config.mediaEnabled,
      mediaMaxSizeBytes: config.mediaMaxSizeMb * 1024 * 1024,
      getGroupWorkspace: (groupId: string) => {
        return ensureGroupWorkspace(
          resolveProjectPath(config.groupsDir),
          groupId,
        );
      },
    });
  }

  if (Object.keys(adapters).length === 0) {
    throw new Error(
      "No adapters enabled. Set MERCURY_ENABLE_WHATSAPP, MERCURY_ENABLE_DISCORD, or MERCURY_ENABLE_SLACK to true",
    );
  }

  const bot = new Chat({
    userName: config.chatSdkUserName,
    adapters,
    state: createMemoryState(),
  });

  // Slack-specific handler: channel→group mapping, pre-route typing, ambient capture
  const handleSlackMessage = createSlackMessageHandler({
    core,
    db: core.db,
    config,
  });

  // Discord-specific handler: channel→group mapping, pre-route typing, ambient capture
  const handleDiscordMessage = createDiscordMessageHandler({
    core,
    db: core.db,
    config,
  });

  // Default handler for WhatsApp/other adapters
  const handleMessage = async (
    thread: Thread,
    message: Message,
    isNew: boolean,
  ) => {
    if (message.author.isMe) return;

    // Delegate to platform-specific handlers early — before any
    // WhatsApp-specific logic (resolveCallerId, @g.us DM check).
    if (thread.adapter.name === "slack") {
      return handleSlackMessage(thread, message, isNew);
    }
    if (thread.adapter.name === "discord") {
      return handleDiscordMessage(thread, message, isNew);
    }

    const callerId = resolveCallerId(message, thread);

    // thread.isDM is unreliable for WhatsApp LID JIDs — derive from thread ID
    const isDM = thread.isDM || !thread.id.includes("@g.us");

    // Quick trigger check before starting typing indicator
    const text = message.text.trim();

    // Extract attachments and reply flag from message metadata (populated by adapters)
    const metadata = message.metadata as {
      attachments?: unknown;
      isReplyToBot?: boolean;
    };
    const attachments = metadata?.attachments ?? [];
    const isReplyToBot = metadata?.isReplyToBot ?? false;

    // Allow messages with only attachments (no text)
    if (!text && (!Array.isArray(attachments) || attachments.length === 0))
      return;

    const defaultPatterns = config.triggerPatterns
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const triggerConfig = loadTriggerConfig(core.db, thread.id, {
      patterns: defaultPatterns,
      match: config.triggerMatch,
    });
    const triggerResult = matchTrigger(text, triggerConfig, isDM);

    // Start typing if trigger matched, DM, or reply to bot
    const shouldStartTyping = triggerResult.matched || (isReplyToBot && !isDM);
    if (shouldStartTyping) {
      if (isNew) await thread.subscribe();
      await thread.startTyping();
    }

    const result = await core.handleRawInput({
      groupId: thread.id,
      rawText: message.text,
      callerId,
      authorName: message.author.userName,
      isDM,
      isReplyToBot,
      source: "chat-sdk",
      attachments: Array.isArray(attachments) ? attachments : [],
    });

    if (result.type === "ignore") return;

    if (result.type === "assistant" && result.reply) {
      await thread.post(result.reply);
    } else if (result.type === "command" && result.reply) {
      await thread.post(result.reply);
    } else if (result.type === "denied") {
      await thread.post(result.reason);
    }
  };

  bot.onNewMention((thread, message) => {
    void handleMessage(thread, message, true).catch((error) =>
      logger.error(
        "Message handler failed",
        error instanceof Error ? error : undefined,
      ),
    );
  });

  bot.onSubscribedMessage((thread, message) => {
    void handleMessage(thread, message, false).catch((error) =>
      logger.error(
        "Message handler failed",
        error instanceof Error ? error : undefined,
      ),
    );
  });

  // Message sender for scheduled task replies
  const messageSender: import("./types.js").MessageSender = {
    async send(groupId, text) {
      const [platform] = groupId.split(":");
      const adapter = adapters[platform];
      if (!adapter) {
        logger.warn("Message dropped — no adapter for platform", {
          groupId,
          platform,
        });
        return;
      }
      await adapter.postMessage(groupId, text);
    },
  };

  core.startScheduler(messageSender);
  core.startKbDistill();
  await bot.initialize();

  const webhooks = bot.webhooks as Record<string, WebhookHandler>;

  const waitUntil: WaitUntil = (task) => {
    void task.catch((error) => {
      logger.error(
        "Background task failed",
        error instanceof Error ? error : undefined,
      );
    });
  };

  const apiCtx = {
    db: core.db,
    config,
    containerRunner: core.containerRunner,
    queue: core.queue,
    scheduler: core.scheduler,
  };

  const server = Bun.serve({
    port: config.chatSdkPort,
    fetch: async (request) => {
      const url = new URL(request.url);

      // Dashboard — serve static HTML
      if (
        (url.pathname === "/" || url.pathname === "/dashboard") &&
        request.method === "GET"
      ) {
        try {
          const html = readFileSync(
            join(__dirname, "dashboard/index.html"),
            "utf8",
          );
          return new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        } catch {
          return new Response("Dashboard not found", { status: 404 });
        }
      }

      // Dashboard activity endpoint — public, read-only
      if (url.pathname === "/dashboard/activity" && request.method === "GET") {
        const groups = core.db.listGroups();
        const activity: Array<{
          group: string;
          role: string;
          preview: string;
          time: number;
        }> = [];
        for (const g of groups.slice(0, 5)) {
          const msgs = core.db.getRecentMessages(g.id, 3);
          for (const m of msgs) {
            activity.push({
              group: g.id.split(":")[0],
              role: m.role,
              preview: m.content.slice(0, 60),
              time: m.createdAt,
            });
          }
        }
        activity.sort((a, b) => b.time - a.time);
        return new Response(
          JSON.stringify({ activity: activity.slice(0, 10) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Dashboard data endpoint — public, read-only
      if (url.pathname === "/dashboard/data" && request.method === "GET") {
        const groups = core.db
          .listGroups()
          .map((g) => {
            // Parse group ID to get platform and readable ID
            const parts = g.id.split(":");
            const platform = parts[0];
            // For WhatsApp, show last 8 chars of ID
            // For Slack/Discord, might have channel names
            let shortId = parts.slice(1).join(":");
            if (shortId.length > 20) shortId = `...${shortId.slice(-15)}`;

            return {
              id: g.id,
              platform,
              shortId,
              title: g.title !== g.id ? g.title : null,
              lastActivity: g.updatedAt,
            };
          })
          .sort((a, b) => b.lastActivity - a.lastActivity);

        const tasks = core.db.listTasks();
        const activeGroups = core.containerRunner.getActiveGroups();

        // Collect roles across all groups
        const roles: Array<{
          groupId: string;
          platform: string;
          userId: string;
          role: string;
        }> = [];
        for (const g of groups) {
          const groupRoles = core.db.listRoles(g.id);
          for (const r of groupRoles) {
            roles.push({
              groupId: g.id,
              platform: g.platform,
              userId: r.platformUserId,
              role: r.role,
            });
          }
        }

        return new Response(
          JSON.stringify({ groups, tasks, activeGroups, roles }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Health check endpoint — no auth required
      if (url.pathname === "/health" && request.method === "GET") {
        const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        const adapterStatus: Record<string, boolean> = {};
        for (const name of Object.keys(adapters)) {
          adapterStatus[name] = true;
        }
        return new Response(
          JSON.stringify({
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
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // WhatsApp auth status endpoint — no auth required (for headless deployments)
      if (url.pathname === "/auth/whatsapp" && request.method === "GET") {
        const whatsappAdapter = adapters.whatsapp as
          | WhatsAppBaileysAdapter
          | undefined;
        if (!whatsappAdapter) {
          return new Response(
            JSON.stringify({ error: "WhatsApp adapter not enabled" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        const status = whatsappAdapter.getQrStatus();
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Internal API — used by mercury-ctl from inside containers
      if (url.pathname.startsWith("/api/")) {
        return handleApiRequest(request, url, apiCtx);
      }

      logger.info("Incoming request", {
        method: request.method,
        path: url.pathname,
      });

      const match = url.pathname.match(/^\/webhooks\/([a-z0-9_-]+)$/i);
      if (!match) {
        return new Response("Not found", { status: 404 });
      }

      const platform = match[1];
      logger.info("Webhook dispatch", { platform });
      const handler = webhooks[platform];
      if (!handler) {
        return new Response(`Unknown platform: ${platform}`, { status: 404 });
      }

      return handler(request, { waitUntil });
    },
  });

  // Register shutdown hooks for adapters and server
  core.onShutdown(async () => {
    logger.info("Shutdown: closing chat adapters");
    for (const [name, adapter] of Object.entries(adapters)) {
      try {
        if ("shutdown" in adapter && typeof adapter.shutdown === "function") {
          await (adapter as { shutdown: () => Promise<void> }).shutdown();
          logger.info("Shutdown: adapter disconnected", { adapter: name });
        }
      } catch (err) {
        logger.error("Shutdown: failed to disconnect adapter", {
          adapter: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  core.onShutdown(async () => {
    logger.info("Shutdown: stopping HTTP server");
    server.stop(true);
  });

  core.installSignalHandlers();

  logger.info("Server started", {
    port: server.port,
    image: config.agentContainerImage,
    adapters: Object.keys(adapters).join(", "),
  });
  logger.info("Webhook path pattern: POST /webhooks/:platform");
  logger.info("Internal API: /api/*");
  if (adapters.discord) {
    logger.info("Discord enabled (native adapter with persistent connection)");
  }
  if (adapters.whatsapp) {
    logger.info("WhatsApp enabled", {
      authDir: resolveProjectPath(config.whatsappAuthDir),
    });
  }
}

main().catch((error) => {
  logger.error("Startup failed", error instanceof Error ? error : undefined);
  process.exit(1);
});
