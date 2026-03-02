import { ContainerError } from "../agent/container-error.js";
import { AgentContainerRunner } from "../agent/container-runner.js";
import { kbDistill } from "../cli/kb-distill.js";
import { type AppConfig, resolveProjectPath } from "../config.js";
import { logger } from "../logger.js";
import { Db } from "../storage/db.js";
import {
  ensureGroupWorkspace,
  ensurePiResourceDir,
} from "../storage/memory.js";
import type { MessageAttachment, MessageSender } from "../types.js";
import { GroupQueue } from "./group-queue.js";
import { RateLimiter } from "./rate-limiter.js";
import { type RouteResult, routeInput } from "./router.js";
import { TaskScheduler } from "./task-scheduler.js";

export type InputSource = "cli" | "scheduler" | "chat-sdk";

export type ShutdownHook = () => Promise<void> | void;

export class MercuryCoreRuntime {
  readonly db: Db;
  readonly scheduler: TaskScheduler;
  readonly queue: GroupQueue;
  readonly containerRunner: AgentContainerRunner;
  readonly rateLimiter: RateLimiter;
  private readonly shutdownHooks: ShutdownHook[] = [];
  private shuttingDown = false;
  private signalHandlersInstalled = false;
  private kbDistillTimer: NodeJS.Timeout | null = null;

  constructor(readonly config: AppConfig) {
    this.db = new Db(resolveProjectPath(config.dbPath));
    this.queue = new GroupQueue(config.maxConcurrency);
    this.scheduler = new TaskScheduler(this.db);
    this.containerRunner = new AgentContainerRunner(config);
    this.rateLimiter = new RateLimiter(
      config.rateLimitPerUser,
      config.rateLimitWindowMs,
    );

    // Scaffold global (pi agent dir) and "main" (admin DM workspace)
    ensurePiResourceDir(resolveProjectPath(config.globalDir));
    ensureGroupWorkspace(resolveProjectPath(config.groupsDir), "main");
  }

  /**
   * Initialize the runtime — must be called before accepting work.
   * Cleans up any orphaned containers from previous runs.
   */
  async initialize(): Promise<void> {
    await this.containerRunner.cleanupOrphans();
    this.rateLimiter.startCleanup();
  }

  startScheduler(sender?: MessageSender): void {
    this.scheduler.start(async (task) => {
      const reply = await this.executePrompt(
        task.groupId,
        task.prompt,
        "scheduler",
        task.createdBy,
      );
      if (!task.silent && sender) {
        await sender.send(task.groupId, reply);
      }
    });
  }

  stopScheduler(): void {
    this.scheduler.stop();
  }

  startKbDistill(): void {
    const intervalMs = this.config.kbDistillIntervalMs;
    if (intervalMs <= 0) return;

    logger.info("Starting KB distillation", { intervalMs });

    // Run immediately on start, then on interval
    void this.runKbDistill();

    this.kbDistillTimer = setInterval(() => {
      void this.runKbDistill();
    }, intervalMs);
  }

  stopKbDistill(): void {
    if (this.kbDistillTimer) {
      clearInterval(this.kbDistillTimer);
      this.kbDistillTimer = null;
    }
  }

  private async runKbDistill(): Promise<void> {
    try {
      logger.info("Running KB distillation");
      await kbDistill({
        dataDir: resolveProjectPath(this.config.dataDir),
        backfill: false,
      });
      logger.info("KB distillation complete");
    } catch (err) {
      logger.error(
        "KB distillation failed",
        err instanceof Error ? err : undefined,
      );
    }
  }

  async handleRawInput(input: {
    groupId: string;
    rawText: string;
    callerId: string;
    authorName?: string;
    isDM: boolean;
    isReplyToBot?: boolean;
    source: Exclude<InputSource, "scheduler">;
    attachments?: MessageAttachment[];
  }): Promise<RouteResult & { reply?: string }> {
    const route = routeInput({
      rawText: input.rawText,
      groupId: input.groupId,
      callerId: input.callerId,
      isDM: input.isDM,
      isReplyToBot: input.isReplyToBot,
      db: this.db,
      config: this.config,
    });

    if (route.type === "command") {
      const reply = this.executeCommand(input.groupId, route.command);
      return { ...route, reply };
    }

    // Check rate limit for assistant requests (not commands, not ignored messages)
    if (route.type === "assistant") {
      // Check per-group override first
      const groupLimit = this.db.getGroupConfig(input.groupId, "rate_limit");
      const effectiveLimit = groupLimit
        ? Number.parseInt(groupLimit, 10)
        : this.config.rateLimitPerUser;

      if (
        effectiveLimit > 0 &&
        !this.checkRateLimit(input.groupId, input.callerId, effectiveLimit)
      ) {
        return {
          type: "denied",
          reason: "Rate limit exceeded. Try again shortly.",
        };
      }
    }

    if (route.type !== "assistant") {
      // Store ambient messages in group chats (non-triggered, non-DM)
      if (
        route.type === "ignore" &&
        input.source === "chat-sdk" &&
        !input.isDM
      ) {
        const ambientText = input.authorName
          ? `${input.authorName}: ${input.rawText.trim()}`
          : input.rawText.trim();

        if (ambientText) {
          this.db.ensureGroup(input.groupId);
          this.db.addMessage(input.groupId, "ambient", ambientText);
        }
      }

      return route;
    }

    try {
      const reply = await this.executePrompt(
        input.groupId,
        route.prompt,
        input.source,
        input.callerId,
        input.attachments,
      );
      return { ...route, reply };
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
    groupId: string,
    userId: string,
    effectiveLimit: number,
  ): boolean {
    return this.rateLimiter.isAllowed(groupId, userId, effectiveLimit);
  }

  private executeCommand(groupId: string, command: string): string {
    switch (command) {
      case "stop": {
        const stopped = this.containerRunner.abort(groupId);
        const dropped = this.queue.cancelPending(groupId);
        if (stopped)
          return `Stopped.${dropped > 0 ? ` Dropped ${dropped} queued request(s).` : ""}`;
        if (dropped > 0) return `Dropped ${dropped} queued request(s).`;
        return "No active run.";
      }
      case "compact": {
        this.db.setSessionBoundaryToLatest(groupId);
        return "Compacted.";
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
      this.stopKbDistill();

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

      // 5. Run registered shutdown hooks (adapters, server, etc.)
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
    groupId: string,
    prompt: string,
    _source: InputSource,
    callerId: string,
    attachments?: MessageAttachment[],
  ): Promise<string> {
    this.db.ensureGroup(groupId);
    this.db.addMessage(groupId, "user", prompt, attachments);

    return this.queue.enqueue(groupId, async () => {
      const workspace = ensureGroupWorkspace(
        resolveProjectPath(this.config.groupsDir),
        groupId,
      );
      const history = this.db.getMessagesSinceLastUserTrigger(groupId, 200);

      const reply = await this.containerRunner.reply({
        groupId,
        groupWorkspace: workspace,
        messages: history,
        prompt,
        callerId,
        attachments,
      });

      this.db.addMessage(groupId, "assistant", reply);
      return reply;
    });
  }
}
