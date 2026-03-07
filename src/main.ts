import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, Message } from "chat";
import type { DiscordNativeAdapter } from "./adapters/discord-native.js";
import { setupAdapters } from "./adapters/setup.js";
import type { WhatsAppBaileysAdapter } from "./adapters/whatsapp.js";
import { DiscordBridge } from "./bridges/discord.js";
import { SlackBridge } from "./bridges/slack.js";
import { TeamsBridge } from "./bridges/teams.js";
import { WhatsAppBridge } from "./bridges/whatsapp.js";
import { createChatShim } from "./chat-shim.js";
import { loadConfig, resolveProjectPath } from "./config.js";
import { createMessageHandler } from "./core/handler.js";
import { MercuryCoreRuntime } from "./core/runtime.js";
import { ConfigRegistry } from "./extensions/config-registry.js";
import { ensureDerivedImage } from "./extensions/image-builder.js";
import { JobRunner } from "./extensions/jobs.js";
import { ExtensionRegistry } from "./extensions/loader.js";
import {
  installBuiltinSkills,
  installExtensionSkills,
} from "./extensions/skills.js";
import { configureLogger, logger } from "./logger.js";
import { createApp } from "./server.js";
import { ensureSpaceWorkspace } from "./storage/memory.js";
import type { NormalizeContext, PlatformBridge } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const startTime = Date.now();

async function main() {
  const config = loadConfig();

  configureLogger({
    level: config.logLevel,
    format: config.logFormat,
  });

  // ─── Initialize Core ────────────────────────────────────────────────────

  const core = new MercuryCoreRuntime(config);
  await core.initialize();

  // ─── Load Extensions ────────────────────────────────────────────────────

  const registry = new ExtensionRegistry();
  const configRegistry = new ConfigRegistry();
  const extensionsDir = resolveProjectPath(`${config.dataDir}/extensions`);
  const builtinExtDir = join(__dirname, "extensions");
  await registry.loadAll(
    extensionsDir,
    core.db,
    logger,
    configRegistry,
    builtinExtDir,
  );
  logger.info("Extensions loaded", { count: registry.size });

  // Wire extensions into runtime (hooks, context)
  core.initExtensions(registry);

  // Install skills (extension + built-in)
  const globalDir = resolveProjectPath(config.globalDir);
  installExtensionSkills(registry.list(), globalDir, logger);
  installBuiltinSkills(
    join(PACKAGE_ROOT, "resources/skills"),
    globalDir,
    logger,
  );

  // Build derived container image if extensions declare CLIs
  const agentImage = await ensureDerivedImage(
    config.agentContainerImage,
    registry.list(),
    logger,
  );
  core.containerRunner.setImage(agentImage);

  // ─── Setup Adapters ─────────────────────────────────────────────────────

  const adapters = setupAdapters(config);

  // ─── Platform Bridges ─────────────────────────────────────────────────

  const bridges: Record<string, PlatformBridge> = {};

  if (adapters.whatsapp) {
    bridges.whatsapp = new WhatsAppBridge(
      adapters.whatsapp as WhatsAppBaileysAdapter,
    );
  }
  if (adapters.discord) {
    bridges.discord = new DiscordBridge(
      adapters.discord as DiscordNativeAdapter,
    );
  }
  if (adapters.slack) {
    const slackBotToken = process.env.MERCURY_SLACK_BOT_TOKEN;
    if (!slackBotToken) {
      throw new Error("Slack enabled but MERCURY_SLACK_BOT_TOKEN is missing");
    }
    bridges.slack = new SlackBridge(adapters.slack, slackBotToken);
  }
  if (adapters.teams) {
    bridges.teams = new TeamsBridge(adapters.teams);
  }

  const normalizeCtx: NormalizeContext = {
    botUserName: config.chatSdkUserName,
    getWorkspace: (spaceId) =>
      ensureSpaceWorkspace(resolveProjectPath(config.spacesDir), spaceId),
    media: {
      enabled: config.mediaEnabled,
      maxSizeBytes: config.mediaMaxSizeMb * 1024 * 1024,
    },
  };

  const handlers = new Map<string, ReturnType<typeof createMessageHandler>>();
  for (const [name, bridge] of Object.entries(bridges)) {
    handlers.set(
      name,
      createMessageHandler({ bridge, core, config, ctx: normalizeCtx }),
    );
  }

  // ─── Message Dispatch ───────────────────────────────────────────────────

  const onMessage = (adapter: Adapter, threadId: string, message: Message) => {
    const handler = handlers.get(adapter.name);
    if (handler) {
      void handler(adapter, threadId, message).catch((error) =>
        logger.error(
          "Message handler failed",
          error instanceof Error ? error : undefined,
        ),
      );
    } else {
      logger.warn("No bridge for adapter", { adapter: adapter.name });
    }
  };

  // Chat shim satisfies Chat SDK adapter interface (initialize, webhooks)
  // without the full Chat routing pipeline (subscriptions, mention routing, locks).
  // Mercury handles its own routing via conversation resolution + trigger matching.
  const chatShim = createChatShim(onMessage);

  // ─── Message Sender (for scheduled tasks) ───────────────────────────────

  const messageSender: import("./types.js").MessageSender = {
    async send(groupId, text, files) {
      const [platform] = groupId.split(":");
      const bridge = bridges[platform];
      if (!bridge) {
        logger.warn("Message dropped — no bridge for platform", {
          groupId,
          platform,
        });
        return;
      }
      await bridge.sendReply(groupId, text, files);
    },
  };

  // ─── Start Services ─────────────────────────────────────────────────────

  core.startScheduler(messageSender);

  // Start extension background jobs
  const jobRunner = new JobRunner();
  jobRunner.start(registry.list(), {
    db: core.db,
    config,
    log: logger,
  });
  core.onShutdown(() => jobRunner.stop());

  // Initialize adapters via shim (calls adapter.initialize(chatShim))
  for (const [name, adapter] of Object.entries(adapters)) {
    logger.info("Initializing adapter", { adapter: name });
    await adapter.initialize(chatShim);
  }

  // ─── Create HTTP Server ─────────────────────────────────────────────────

  // Build webhook handlers — each adapter's handleWebhook is called directly
  const webhooks: Record<
    string,
    (
      request: Request,
      options?: { waitUntil?: (task: Promise<unknown>) => void },
    ) => Promise<Response>
  > = {};

  for (const [name, adapter] of Object.entries(adapters)) {
    webhooks[name] = (request, options) =>
      adapter.handleWebhook(request, options);
  }

  const app = createApp({
    core,
    config,
    adapters,
    webhooks,
    startTime,
    registry,
    configRegistry,
  });

  const server = Bun.serve({
    port: config.chatSdkPort,
    fetch: app.fetch,
  });

  // ─── Shutdown Hooks ─────────────────────────────────────────────────────

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

  // ─── Startup Logs ───────────────────────────────────────────────────────

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
  if (adapters.teams) {
    logger.info("Teams enabled (webhook via Azure Bot Service)");
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
