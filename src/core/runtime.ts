import path from "node:path";
import { ContainerError } from "../agent/container-error.js";
import { AgentContainerRunner } from "../agent/container-runner.js";
import { type AppConfig, resolveProjectPath } from "../config.js";
import { HookDispatcher } from "../extensions/hooks.js";
import type { ExtensionRegistry } from "../extensions/loader.js";
import type { MercuryExtensionContext } from "../extensions/types.js";
import { logger } from "../logger.js";
import { Db } from "../storage/db.js";
import {
  ensurePiResourceDir,
  ensureSpaceWorkspace,
} from "../storage/memory.js";
import type {
  ContainerResult,
  IngressMessage,
  MessageAttachment,
  MessageSender,
} from "../types.js";
import { compactSession } from "./compact.js";
import { hasPermission, resolveRole } from "./permissions.js";
import { RateLimiter } from "./rate-limiter.js";
import { type RouteResult, routeInput } from "./router.js";
import { SpaceQueue } from "./space-queue.js";
import { TaskScheduler } from "./task-scheduler.js";

export type InputSource = "cli" | "scheduler" | "chat-sdk";

export type ShutdownHook = () => Promise<void> | void;

export class MercuryCoreRuntime {
  readonly db: Db;
  readonly scheduler: TaskScheduler;
  readonly queue: SpaceQueue;
  readonly containerRunner: AgentContainerRunner;
  readonly rateLimiter: RateLimiter;
  hooks: HookDispatcher | null = null;
  private extensionCtx: MercuryExtensionContext | null = null;
  private extensionRegistry: ExtensionRegistry | null = null;
  private readonly shutdownHooks: ShutdownHook[] = [];
  private shuttingDown = false;
  private signalHandlersInstalled = false;

  constructor(readonly config: AppConfig) {
    this.db = new Db(resolveProjectPath(config.dbPath));
    this.queue = new SpaceQueue(config.maxConcurrency);
    this.scheduler = new TaskScheduler(this.db);
    this.containerRunner = new AgentContainerRunner(config);
    this.rateLimiter = new RateLimiter(
      config.rateLimitPerUser,
      config.rateLimitWindowMs,
    );

    // Scaffold global (pi agent dir) and "main" (default space)
    ensurePiResourceDir(resolveProjectPath(config.globalDir));
    ensureSpaceWorkspace(resolveProjectPath(config.spacesDir), "main");
  }

  /**
   * Initialize the runtime — must be called before accepting work.
   * Cleans up any orphaned containers from previous runs.
   */
  async initialize(): Promise<void> {
    await this.containerRunner.cleanupOrphans();
    this.rateLimiter.startCleanup();
  }

  /**
   * Wire extension system into the runtime.
   * Must be called after extensions are loaded and before accepting messages.
   */
  initExtensions(registry: ExtensionRegistry): void {
    this.hooks = new HookDispatcher(registry, logger);
    this.extensionRegistry = registry;
    this.extensionCtx = {
      db: this.db,
      config: this.config,
      log: logger,
    };
  }

  startScheduler(sender?: MessageSender): void {
    this.scheduler.start(async (task) => {
      const result = await this.executePrompt(
        task.spaceId,
        task.prompt,
        "scheduler",
        task.createdBy,
      );
      if (!task.silent && sender) {
        await sender.send(task.spaceId, result.reply, result.files);
      }
    });
  }

  stopScheduler(): void {
    this.scheduler.stop();
  }

  async handleRawInput(
    message: IngressMessage,
    source: Exclude<InputSource, "scheduler">,
  ): Promise<RouteResult & { result?: ContainerResult }> {
    const route = routeInput({
      text: message.text,
      spaceId: message.spaceId,
      callerId: message.callerId,
      isDM: message.isDM,
      isReplyToBot: message.isReplyToBot,
      db: this.db,
      config: this.config,
    });

    if (route.type === "command") {
      const reply = await this.executeCommand(message.spaceId, route.command);
      return { ...route, result: { reply, files: [] } };
    }

    // Check rate limit for assistant requests (not commands, not ignored messages)
    if (route.type === "assistant") {
      // Check per-group override first
      const groupLimit = this.db.getSpaceConfig(message.spaceId, "rate_limit");
      const effectiveLimit = groupLimit
        ? Number.parseInt(groupLimit, 10)
        : this.config.rateLimitPerUser;

      if (
        effectiveLimit > 0 &&
        !this.checkRateLimit(message.spaceId, message.callerId, effectiveLimit)
      ) {
        return {
          type: "denied",
          reason: "Rate limit exceeded. Try again shortly.",
        };
      }
    }

    if (route.type !== "assistant") {
      // Store ambient messages in group chats (non-triggered, non-DM)
      if (route.type === "ignore" && source === "chat-sdk" && !message.isDM) {
        const ambientText = message.authorName
          ? `${message.authorName}: ${message.text.trim()}`
          : message.text.trim();

        if (ambientText) {
          this.db.ensureSpace(message.spaceId);
          this.db.addMessage(message.spaceId, "ambient", ambientText);
        }
      }

      return route;
    }

    try {
      const result = await this.executePrompt(
        message.spaceId,
        route.prompt,
        source,
        message.callerId,
        message.attachments,
      );
      return { ...route, result };
    } catch (error) {
      if (error instanceof ContainerError) {
        switch (error.reason) {
          case "aborted":
            return { type: "denied", reason: "Stopped current run." };
          case "timeout":
            return { type: "denied", reason: "Container timed out." };
          case "oom":
            return {
              type: "denied",
              reason: "Container was killed (possibly out of memory).",
            };
          case "error":
            logger.error(
              "Container error",
              error instanceof Error ? error : undefined,
            );
            throw error;
        }
      }
      throw error;
    }
  }

  /**
   * Check if a request is allowed under rate limiting.
   * Uses per-group override if set, otherwise uses the default limit.
   */
  private checkRateLimit(
    spaceId: string,
    userId: string,
    effectiveLimit: number,
  ): boolean {
    return this.rateLimiter.isAllowed(spaceId, userId, effectiveLimit);
  }

  private async executeCommand(
    spaceId: string,
    command: string,
  ): Promise<string> {
    switch (command) {
      case "stop": {
        const stopped = this.containerRunner.abort(spaceId);
        const dropped = this.queue.cancelPending(spaceId);
        if (stopped)
          return `Stopped.${dropped > 0 ? ` Dropped ${dropped} queued request(s).` : ""}`;
        if (dropped > 0) return `Dropped ${dropped} queued request(s).`;
        return "No active run.";
      }
      case "compact": {
        const workspace = path.resolve(this.config.spacesDir, spaceId);
        const sessionFile = path.join(workspace, ".mercury.session.jsonl");
        const result = await compactSession(sessionFile, this.config);
        this.db.setSessionBoundaryToLatest(spaceId);
        if (result.compacted) {
          return "Compacted.";
        }
        return result.error
          ? `Compact: ${result.error}`
          : "Nothing to compact.";
      }
      default:
        return `Unknown command: ${command}`;
    }
  }

  onShutdown(hook: ShutdownHook): void {
    this.shutdownHooks.push(hook);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  installSignalHandlers(): void {
    if (this.signalHandlersInstalled) return;
    this.signalHandlersInstalled = true;

    let forceCount = 0;

    const handler = (signal: string) => {
      if (this.shuttingDown) {
        forceCount++;
        if (forceCount >= 1) {
          logger.warn("Second signal received, forcing exit");
          process.exit(1);
        }
        return;
      }
      logger.info("Received signal, starting graceful shutdown", { signal });
      void this.shutdown().then(
        () => process.exit(0),
        (err) => {
          logger.error(
            "Shutdown failed",
            err instanceof Error ? err : undefined,
          );
          process.exit(1);
        },
      );
    };

    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("SIGINT", () => handler("SIGINT"));
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    const forceTimer = setTimeout(() => {
      logger.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);
    // Don't keep the process alive just for this timer
    if (forceTimer.unref) forceTimer.unref();

    try {
      // 1. Stop schedulers
      logger.info("Shutdown: stopping task scheduler");
      this.scheduler.stop();

      // 2. Drain queue — cancel pending, wait for active
      logger.info("Shutdown: draining group queue");
      const dropped = this.queue.cancelAll();
      if (dropped > 0)
        logger.info("Shutdown: cancelled pending queue entries", {
          count: dropped,
        });

      // 3. Kill running containers
      logger.info("Shutdown: stopping running containers");
      this.containerRunner.killAll();

      // 4. Wait for active work to finish (with a shorter timeout)
      const drainTimeout = Math.max(timeoutMs - 2000, 1000);
      const drained = await this.queue.waitForActive(drainTimeout);
      if (!drained) {
        logger.warn("Shutdown: active work did not finish in time");
      }

      // 5. Emit extension shutdown hooks
      if (this.hooks && this.extensionCtx) {
        logger.info("Shutdown: notifying extensions");
        await this.hooks.emit("shutdown", {}, this.extensionCtx);
      }

      // 6. Run registered shutdown hooks (adapters, server, etc.)
      for (const hook of this.shutdownHooks) {
        try {
          await hook();
        } catch (err) {
          logger.error(
            "Shutdown hook failed",
            err instanceof Error ? err : undefined,
          );
        }
      }

      // 6. Stop rate limiter cleanup
      this.rateLimiter.stopCleanup();

      // 7. Close database
      logger.info("Shutdown: closing database");
      this.db.close();

      logger.info("Shutdown: complete");
    } finally {
      clearTimeout(forceTimer);
    }
  }

  private async executePrompt(
    spaceId: string,
    prompt: string,
    _source: InputSource,
    callerId: string,
    attachments?: MessageAttachment[],
  ): Promise<ContainerResult> {
    this.db.ensureSpace(spaceId);
    this.db.addMessage(spaceId, "user", prompt, attachments);

    return this.queue.enqueue(spaceId, async () => {
      const workspace = ensureSpaceWorkspace(
        resolveProjectPath(this.config.spacesDir),
        spaceId,
      );

      // Container-relative workspace path
      const containerWorkspace = `/spaces/${spaceId}`;

      // Emit workspace_init hook (extensions should be idempotent)
      if (this.hooks && this.extensionCtx) {
        await this.hooks.emit(
          "workspace_init",
          { spaceId, workspace, containerWorkspace },
          this.extensionCtx,
        );
      }

      // Emit before_container hook
      let extraEnv: Record<string, string> | undefined;
      if (this.hooks && this.extensionCtx) {
        const result = await this.hooks.emitBeforeContainer(
          { spaceId, prompt, callerId, workspace, containerWorkspace },
          this.extensionCtx,
        );
        if (result?.block) {
          return { reply: result.block.reason, files: [] };
        }
        if (result?.systemPrompt) {
          extraEnv = {
            ...result.env,
            MERCURY_EXT_SYSTEM_PROMPT: result.systemPrompt,
          };
        } else if (result?.env) {
          extraEnv = result.env;
        }
      }

      // Compute denied extension CLIs for this caller
      if (this.extensionRegistry) {
        const cliExtensions = this.extensionRegistry.getCliExtensions();
        if (cliExtensions.length > 0) {
          const seededAdmins = this.config.admins
            ? this.config.admins
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
          const role = resolveRole(this.db, spaceId, callerId, seededAdmins);
          const denied = cliExtensions
            .filter(
              (ext) =>
                ext.cli && !hasPermission(this.db, spaceId, role, ext.name),
            )
            .map((ext) => ext.cli!.name);
          if (denied.length > 0) {
            extraEnv = {
              ...extraEnv,
              MERCURY_DENIED_CLIS: denied.join(","),
            };
          }
        }
      }

      const history = this.db.getMessagesSinceLastUserTrigger(spaceId, 200);
      const startTime = Date.now();

      const containerResult = await this.containerRunner.reply({
        spaceId,
        spaceWorkspace: workspace,
        messages: history,
        prompt,
        callerId,
        attachments,
        extraEnv,
      });

      const durationMs = Date.now() - startTime;

      // Emit after_container hook
      if (this.hooks && this.extensionCtx) {
        const hookResult = await this.hooks.emitAfterContainer(
          { spaceId, prompt, reply: containerResult.reply, durationMs },
          this.extensionCtx,
        );
        if (hookResult?.suppress) {
          return { reply: "", files: [] };
        }
        if (hookResult?.reply !== undefined) {
          containerResult.reply = hookResult.reply;
        }
      }

      this.db.addMessage(spaceId, "assistant", containerResult.reply);

      return containerResult;
    });
  }
}
