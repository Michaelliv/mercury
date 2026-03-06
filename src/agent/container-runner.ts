import {
  type ChildProcessWithoutNullStreams,
  execSync,
  spawn,
} from "node:child_process";
import fs from "node:fs";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { scanOutbox } from "../core/outbox.js";
import { type Logger, logger } from "../logger.js";
import { getApiKeyFromPiAuthFile } from "../storage/pi-auth.js";
import type {
  ContainerResult,
  MessageAttachment,
  StoredMessage,
} from "../types.js";
import { ContainerError } from "./container-error.js";

const START = "---MERCURY_CONTAINER_RESULT_START---";
const END = "---MERCURY_CONTAINER_RESULT_END---";

const CONTAINER_LABEL = "mercury.managed=true";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "../..");

/** Exit code 137 = SIGKILL (128 + 9), typically from OOM killer */
const OOM_EXIT_CODE = 137;

export class AgentContainerRunner {
  private readonly runningByGroup = new Map<
    string,
    { proc: ChildProcessWithoutNullStreams; containerName: string }
  >();
  private readonly abortedGroups = new Set<string>();
  private readonly timedOutGroups = new Set<string>();
  private containerCounter = 0;
  private imageOverride: string | undefined;

  constructor(private readonly config: AppConfig) {
    this.validateImage();
  }

  /** Override the container image (e.g., derived image with extension CLIs). */
  setImage(image: string): void {
    this.imageOverride = image;
  }

  /** The image to use for container spawns. */
  get image(): string {
    return this.imageOverride ?? this.config.agentContainerImage;
  }

  /**
   * Warn if using a custom image that might be missing required tools.
   * Known presets (mercury-agent:*) are assumed to be valid.
   */
  private validateImage(): void {
    const image = this.config.agentContainerImage;

    // Skip validation for known presets
    if (
      image.startsWith("mercury-agent:") ||
      image.includes("/mercury-agent:")
    ) {
      return;
    }

    // For custom images, log a warning about requirements
    logger.warn("Using custom agent image", {
      image,
      note: "Ensure image has: bun, pi, agent-browser, napkin, mrctl",
      docs: "See docs/container-lifecycle.md for custom image requirements",
    });
  }

  isRunning(groupId: string): boolean {
    return this.runningByGroup.has(groupId);
  }

  /**
   * Clean up any orphaned containers from previous runs.
   * Should be called on startup before accepting new work.
   */
  async cleanupOrphans(): Promise<number> {
    try {
      // Find all containers with our label (running or stopped)
      const result = execSync(
        `docker ps -a --filter "label=${CONTAINER_LABEL}" --format "{{.ID}}"`,
        { encoding: "utf8", timeout: 10_000 },
      ).trim();

      if (!result) return 0;

      const containerIds = result.split("\n").filter(Boolean);
      if (containerIds.length === 0) return 0;

      logger.info("Found orphaned containers, cleaning up", {
        count: containerIds.length,
      });

      // Force remove all orphaned containers
      execSync(`docker rm -f ${containerIds.join(" ")}`, {
        encoding: "utf8",
        timeout: 30_000,
      });

      logger.info("Cleaned up orphaned containers", {
        count: containerIds.length,
      });
      return containerIds.length;
    } catch (error) {
      // If docker command fails (e.g., docker not installed), log and continue
      if (error instanceof Error && error.message.includes("ENOENT")) {
        logger.warn("Docker not found, skipping orphan cleanup");
      } else {
        logger.warn(
          "Failed to cleanup orphaned containers",
          error instanceof Error ? error : undefined,
        );
      }
      return 0;
    }
  }

  /**
   * Kill all running containers using docker kill for reliable termination.
   * Note: runningByGroup entries are cleaned up by each process's 'close' handler.
   * During shutdown the process may exit before those fire, but that's fine —
   * Docker cleans up --rm containers regardless.
   */
  killAll(): void {
    for (const [groupId, { proc, containerName }] of this.runningByGroup) {
      this.abortedGroups.add(groupId);
      try {
        execSync(`docker kill ${containerName}`, { timeout: 5000 });
      } catch {
        // docker kill can fail (container exited, daemon issues, etc.) — fall back to process signal
        proc.kill("SIGKILL");
      }
    }
  }

  get activeCount(): number {
    return this.runningByGroup.size;
  }

  getActiveGroups(): string[] {
    return [...this.runningByGroup.keys()];
  }

  abort(groupId: string): boolean {
    const entry = this.runningByGroup.get(groupId);
    if (!entry) return false;

    this.abortedGroups.add(groupId);

    // Use docker kill for reliable container termination
    try {
      execSync(`docker kill ${entry.containerName}`, { timeout: 5000 });
    } catch {
      // docker kill can fail (container exited, daemon issues, etc.) — fall back to process signal
      entry.proc.kill("SIGKILL");
    }
    return true;
  }

  private generateContainerName(): string {
    const id = ++this.containerCounter;
    const timestamp = Date.now();
    return `mercury-${timestamp}-${id}`;
  }

  async reply(input: {
    groupId: string;
    groupWorkspace: string;
    messages: StoredMessage[];
    prompt: string;
    callerId: string;
    attachments?: MessageAttachment[];
    extraEnv?: Record<string, string>;
  }): Promise<ContainerResult> {
    const globalDir = path.resolve(this.config.globalDir);
    const groupsRoot = path.resolve(this.config.groupsDir);

    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(groupsRoot, { recursive: true });

    const authFromPi = await getApiKeyFromPiAuthFile({
      provider: this.config.modelProvider,
      authPath: this.config.authPath ?? path.join(globalDir, "auth.json"),
    });

    // Pass all MERCURY_* vars to container with prefix stripped
    // e.g. MERCURY_ANTHROPIC_API_KEY -> ANTHROPIC_API_KEY
    const passthroughEnvPairs = Object.entries(process.env)
      .filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("MERCURY_") && entry[1] !== undefined,
      )
      .map(([key, value]) => ({
        key: key.replace("MERCURY_", ""),
        value: value,
      }));

    // Check for pi auth file fallback for Anthropic
    const hasAnthropicKey = passthroughEnvPairs.some(
      (p) => p.key === "ANTHROPIC_API_KEY" || p.key === "ANTHROPIC_OAUTH_TOKEN",
    );
    if (
      !hasAnthropicKey &&
      this.config.modelProvider === "anthropic" &&
      authFromPi
    ) {
      passthroughEnvPairs.push({
        key: "ANTHROPIC_OAUTH_TOKEN",
        value: authFromPi,
      });
    }

    const envPairs = [
      // Internal vars (set by code, not from env)
      { key: "HOME", value: "/home/node" },
      { key: "PI_CODING_AGENT_DIR", value: "/home/node/.pi/agent" },
      { key: "CALLER_ID", value: input.callerId },
      { key: "GROUP_ID", value: input.groupId },
      {
        key: "API_URL",
        value: `http://host.docker.internal:${this.config.chatSdkPort}`,
      },
      // Passthrough vars (MERCURY_* with prefix stripped)
      ...passthroughEnvPairs,
    ].filter((x): x is { key: string; value: string } => Boolean(x.value));

    const containerName = this.generateContainerName();

    // Resolve docs paths for self-documenting agent
    const docsDir = path.resolve(PACKAGE_ROOT, "docs");
    const readmePath = path.resolve(PACKAGE_ROOT, "README.md");

    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--label",
      CONTAINER_LABEL,
      "-v",
      `${groupsRoot}:/groups`,
      "-v",
      `${globalDir}:/home/node/.pi/agent`,
      "-v",
      `${readmePath}:/docs/mercury/README.md:ro`,
      "-v",
      `${docsDir}:/docs/mercury/docs:ro`,
    ];

    for (const { key, value } of envPairs) {
      args.push("-e", `${key}=${value}`);
    }

    // Extension env vars from before_container hooks
    if (input.extraEnv) {
      for (const [key, value] of Object.entries(input.extraEnv)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    args.push(this.image);

    const payload = {
      ...input,
      groupWorkspace: input.groupWorkspace.replace(groupsRoot, "/groups"),
    };

    // Create child logger with context for this container run
    const log: Logger = logger.child({
      groupId: input.groupId,
      container: containerName,
    });

    const startTime = Date.now();

    return new Promise<ContainerResult>((resolve, reject) => {
      const proc = spawn("docker", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.runningByGroup.set(input.groupId, { proc, containerName });

      // Log container start
      log.info("Container started", { event: "container.start" });

      let stdout = "";
      let stderr = "";
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      // Set up timeout
      timeoutTimer = setTimeout(() => {
        if (this.runningByGroup.has(input.groupId)) {
          this.timedOutGroups.add(input.groupId);
          log.warn("Container timeout, killing", {
            event: "container.timeout",
          });

          // Force kill the container by name (more reliable than SIGTERM to docker run)
          try {
            execSync(`docker kill ${containerName}`, { timeout: 5000 });
          } catch {
            // Container may have already exited
            proc.kill("SIGKILL");
          }
        }
      }, this.config.containerTimeoutMs);

      const cleanup = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.runningByGroup.delete(input.groupId);
      };

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      proc.on("error", (error) => {
        cleanup();
        reject(error);
      });

      proc.on("close", (code) => {
        cleanup();

        const durationMs = Date.now() - startTime;

        // Check timeout first (before abort check since timeout sets its own state)
        if (this.timedOutGroups.has(input.groupId)) {
          this.timedOutGroups.delete(input.groupId);
          log.warn("Container exited", {
            event: "container.end",
            exitCode: code,
            durationMs,
            reason: "timeout",
          });
          reject(ContainerError.timeout(input.groupId));
          return;
        }

        if (this.abortedGroups.has(input.groupId)) {
          this.abortedGroups.delete(input.groupId);
          log.info("Container exited", {
            event: "container.end",
            exitCode: code,
            durationMs,
            reason: "aborted",
          });
          reject(ContainerError.aborted(input.groupId));
          return;
        }

        if (code !== 0) {
          // Check for OOM kill (exit code 137 = 128 + SIGKILL)
          if (code === OOM_EXIT_CODE) {
            log.error("Container exited", {
              event: "container.end",
              exitCode: code,
              durationMs,
              reason: "oom",
            });
            reject(ContainerError.oom(input.groupId, code));
            return;
          }

          log.error("Container exited", {
            event: "container.end",
            exitCode: code,
            durationMs,
            reason: "error",
          });
          reject(ContainerError.error(code ?? 1, stderr || stdout));
          return;
        }

        // Success case
        log.info("Container exited", {
          event: "container.end",
          exitCode: 0,
          durationMs,
        });

        const startIdx = stdout.indexOf(START);
        const endIdx = stdout.indexOf(END);
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
          reject(
            new Error(`Failed to parse container result: ${stdout || stderr}`),
          );
          return;
        }

        const jsonText = stdout.slice(startIdx + START.length, endIdx).trim();
        let parsed: { reply?: string };
        try {
          parsed = JSON.parse(jsonText) as { reply?: string };
        } catch {
          reject(
            new Error(`Malformed container output: ${jsonText.slice(0, 200)}`),
          );
          return;
        }

        const replyText = parsed.reply ?? "Done.";
        const files = scanOutbox(input.groupWorkspace, startTime);
        resolve({ reply: replyText, files });
      });

      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    });
  }
}
