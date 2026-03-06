#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { RESERVED_EXTENSION_NAMES } from "../extensions/reserved.js";
import { kbDistill } from "./kb-distill.js";
import { authenticate } from "./whatsapp-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "../..");
const CWD = process.cwd();
const TEMPLATES_DIR = join(PACKAGE_ROOT, "resources/templates");
const VALID_EXT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8"),
    );
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function copySourceFile(srcRelative: string, destRelative: string): void {
  const src = join(PACKAGE_ROOT, srcRelative);
  const dest = join(CWD, destRelative);

  if (!existsSync(src)) {
    console.error(`Error: Source file not found: ${srcRelative}`);
    process.exit(1);
  }

  const content = readFileSync(src, "utf-8");
  const destDir = dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  writeFileSync(dest, content);
  console.log(`  ✓ ${destRelative}`);
}

function loadEnvFile(envPath: string): Record<string, string> {
  const content = readFileSync(envPath, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  }
  return vars;
}

// Commands
function initAction(): void {
  console.log("🪽 Initializing mercury project...\n");

  // Create .env if it doesn't exist
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    copyFileSync(join(TEMPLATES_DIR, "env.template"), envPath);
    console.log("  ✓ .env");
  } else {
    console.log("  • .env (already exists)");
  }

  // Create data directories
  const dirs = [".mercury", ".mercury/groups", ".mercury/global"];
  for (const dir of dirs) {
    const fullPath = join(CWD, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  ✓ ${dir}/`);
    }
  }

  // Create AGENTS.md for the agent
  const agentsMdPath = join(CWD, ".mercury/global/AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    copyFileSync(join(TEMPLATES_DIR, "AGENTS.md"), agentsMdPath);
    console.log("  ✓ .mercury/global/AGENTS.md");
  } else {
    console.log("  • .mercury/global/AGENTS.md (already exists)");
  }

  // Copy subagent extension
  console.log("\nCopying subagent extension:");
  const extensionsDir = join(CWD, ".mercury/global/extensions/subagent");
  mkdirSync(extensionsDir, { recursive: true });
  const srcExtDir = join(PACKAGE_ROOT, "resources/extensions/subagent");
  for (const file of readdirSync(srcExtDir)) {
    copyFileSync(join(srcExtDir, file), join(extensionsDir, file));
    console.log(`  ✓ .mercury/global/extensions/subagent/${file}`);
  }

  // Copy agent definitions
  console.log("\nCopying agent definitions:");
  const agentsDir = join(CWD, ".mercury/global/agents");
  mkdirSync(agentsDir, { recursive: true });
  const srcAgentsDir = join(PACKAGE_ROOT, "resources/agents");
  for (const file of readdirSync(srcAgentsDir)) {
    copyFileSync(join(srcAgentsDir, file), join(agentsDir, file));
    console.log(`  ✓ .mercury/global/agents/${file}`);
  }

  // Create container directory and files
  const containerDir = join(CWD, "container");
  if (!existsSync(containerDir)) {
    mkdirSync(containerDir, { recursive: true });
  }

  const dockerfilePath = join(CWD, "container/Dockerfile");
  if (!existsSync(dockerfilePath)) {
    copyFileSync(join(PACKAGE_ROOT, "container/Dockerfile"), dockerfilePath);
    console.log("  ✓ container/Dockerfile");
  }

  const buildScriptPath = join(CWD, "container/build.sh");
  if (!existsSync(buildScriptPath)) {
    copyFileSync(join(PACKAGE_ROOT, "container/build.sh"), buildScriptPath);
    chmodSync(buildScriptPath, 0o755);
    console.log("  ✓ container/build.sh");
  }

  // Copy source files needed for container build
  console.log("\nCopying container runtime files:");
  copySourceFile(
    "src/agent/container-entry.ts",
    "src/agent/container-entry.ts",
  );
  copySourceFile("src/cli/mrctl.ts", "src/cli/mrctl.ts");
  copySourceFile("src/extensions/reserved.ts", "src/extensions/reserved.ts");
  copySourceFile("src/types.ts", "src/types.ts");

  // Build container
  console.log("\n📦 Building container image...\n");
  const buildResult = spawnSync("bash", [buildScriptPath], {
    stdio: "inherit",
    cwd: CWD,
  });

  if (buildResult.status !== 0) {
    console.error(
      "\n⚠️  Container build failed. You can retry with 'mercury build'",
    );
  }

  console.log("\n🪽 Initialization complete!");
  console.log("\nNext steps:");
  console.log("  1. Edit .env to set your API keys and enable adapters");
  console.log("  2. Run 'mercury run' to start");
}

async function runAction(): Promise<void> {
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    console.error("Error: .env file not found in current directory.");
    console.error("Run 'mercury init' first, or cd into your mercury project.");
    process.exit(1);
  }

  const envVars = loadEnvFile(envPath);
  const imageName = envVars.MERCURY_AGENT_IMAGE || "mercury-agent:latest";

  const imageCheck = spawnSync("docker", ["image", "inspect", imageName], {
    stdio: "pipe",
  });
  if (imageCheck.status !== 0) {
    console.error(`Error: Container image '${imageName}' not found.`);
    if (imageName.startsWith("ghcr.io/")) {
      console.error(`Run 'docker pull ${imageName}' to pull it.`);
    } else {
      console.error("Run 'mercury build' to build it.");
    }
    process.exit(1);
  }

  console.log("🪽 Starting mercury...\n");

  const entryPoint = join(PACKAGE_ROOT, "src/main.ts");

  const child = spawn("bun", ["run", entryPoint], {
    stdio: "inherit",
    cwd: CWD,
    env: { ...process.env, ...envVars },
  });

  child.on("error", (err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

function buildAction(): void {
  const buildScript = join(CWD, "container/build.sh");

  if (!existsSync(buildScript)) {
    console.error("Error: container/build.sh not found in current directory.");
    console.error("Run 'mercury init' first.");
    process.exit(1);
  }

  const result = spawnSync("bash", [buildScript], {
    stdio: "inherit",
    cwd: CWD,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function statusAction(): void {
  console.log("🪽 mercury status\n");
  console.log(`Project directory: ${CWD}\n`);

  const envPath = join(CWD, ".env");
  const hasEnv = existsSync(envPath);
  console.log(
    `Configuration:   ${hasEnv ? "✓ .env exists" : "✗ .env missing (run 'mercury init')"}`,
  );

  const hasContainerFiles = existsSync(join(CWD, "container/Dockerfile"));
  console.log(
    `Container files: ${hasContainerFiles ? "✓ present" : "✗ missing (run 'mercury init')"}`,
  );

  const imageCheck = spawnSync(
    "docker",
    ["image", "inspect", "mercury-agent:latest"],
    {
      stdio: "pipe",
    },
  );
  const hasImage = imageCheck.status === 0;
  console.log(
    `Container image: ${hasImage ? "✓ mercury-agent:latest" : "✗ not built (run 'mercury build')"}`,
  );

  if (hasEnv) {
    console.log("\nConfigured adapters:");
    const envContent = readFileSync(envPath, "utf-8");

    const hasWhatsApp = /MERCURY_ENABLE_WHATSAPP\s*=\s*true/i.test(envContent);
    const hasSlack = /^[^#]*SLACK_BOT_TOKEN=\S+/m.test(envContent);
    const hasDiscord = /^[^#]*DISCORD_BOT_TOKEN=\S+/m.test(envContent);

    console.log(`  WhatsApp: ${hasWhatsApp ? "✓ enabled" : "○ disabled"}`);
    console.log(
      `  Slack:    ${hasSlack ? "✓ configured" : "○ not configured"}`,
    );
    console.log(
      `  Discord:  ${hasDiscord ? "✓ configured" : "○ not configured"}`,
    );

    const portMatch = envContent.match(/MERCURY_CHATSDK_PORT\s*=\s*(\d+)/);
    const port = portMatch ? portMatch[1] : "3000";

    const portCheck = spawnSync("lsof", ["-i", `:${port}`, "-t"], {
      stdio: "pipe",
    });
    const isRunning =
      portCheck.status === 0 && portCheck.stdout.toString().trim().length > 0;
    console.log(
      `\nStatus: ${isRunning ? `🟢 running (port ${port})` : "⚪ not running"}`,
    );
  }
}

// CLI setup
const program = new Command();

program
  .name("mercury")
  .description("Personal AI assistant for chat platforms")
  .version(getVersion());

program
  .command("init")
  .description("Initialize a new mercury project in current directory")
  .action(initAction);

program
  .command("run")
  .description("Start the chat adapters (WhatsApp/Slack/Discord)")
  .action(runAction);

program
  .command("build")
  .description("Build the agent container image")
  .action(buildAction);

program
  .command("status")
  .description("Show current status and configuration")
  .action(statusAction);

// Auth subcommand
const authCommand = program
  .command("auth")
  .description("Authenticate with chat platforms");

authCommand
  .command("whatsapp")
  .description("Authenticate with WhatsApp via QR code or pairing code")
  .option("--pairing-code", "Use pairing code instead of QR code")
  .option(
    "--phone <number>",
    "Phone number for pairing code (e.g., 14155551234)",
  )
  .action(async (options: { pairingCode?: boolean; phone?: string }) => {
    const envPath = join(CWD, ".env");
    let dataDir = ".mercury";

    if (existsSync(envPath)) {
      const envVars = loadEnvFile(envPath);
      if (envVars.MERCURY_DATA_DIR) {
        dataDir = envVars.MERCURY_DATA_DIR;
      }
    }

    const authDir =
      process.env.MERCURY_WHATSAPP_AUTH_DIR ||
      join(CWD, dataDir, "whatsapp-auth");
    const statusDir = join(CWD, dataDir);

    try {
      await authenticate({
        authDir,
        statusDir,
        usePairingCode: options.pairingCode,
        phoneNumber: options.phone,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Authentication failed:", message);
      process.exit(1);
    }
  });

// KB Distillation command
program
  .command("kb-distill")
  .description("Export messages and run kb-distiller")
  .option("--backfill", "Process all historical messages, not just today")
  .option("--dry-run", "Show what would be done without running distiller")
  .action(async (options: { backfill?: boolean; dryRun?: boolean }) => {
    const envPath = join(CWD, ".env");
    let dataDir = ".mercury";

    if (existsSync(envPath)) {
      const envVars = loadEnvFile(envPath);
      if (envVars.MERCURY_DATA_DIR) {
        dataDir = envVars.MERCURY_DATA_DIR;
      }
    }

    await kbDistill({
      dataDir: join(CWD, dataDir),
      backfill: options.backfill,
      dryRun: options.dryRun,
    });
  });

// Service management commands
const SERVICE_NAME = "mercury";
const LAUNCHD_LABEL = "com.mercury.agent";

function getServicePaths(): {
  systemdUser: string;
  systemdSystem: string;
  launchdPlist: string;
  logDir: string;
} {
  return {
    systemdUser: join(homedir(), ".config/systemd/user/mercury.service"),
    systemdSystem: "/etc/systemd/system/mercury.service",
    launchdPlist: join(
      homedir(),
      "Library/LaunchAgents/com.mercury.agent.plist",
    ),
    logDir: join(CWD, ".mercury/logs"),
  };
}

function checkCommandExists(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0;
}

function generateSystemdService(userMode: boolean): string {
  const bunPath = process.execPath;
  const mercuryScript = process.argv[1];
  const workDir = CWD;

  return `[Unit]
Description=Mercury Chat Agent
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} run ${mercuryScript} run
WorkingDirectory=${workDir}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=${userMode ? "default.target" : "multi-user.target"}
`;
}

function generateLaunchdPlist(): string {
  const bunPath = process.execPath;
  const mercuryScript = process.argv[1];
  const workDir = CWD;
  const { logDir } = getServicePaths();

  // Capture current PATH so docker and other tools are available
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${mercuryScript}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${currentPath}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/mercury.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/mercury.error.log</string>
</dict>
</plist>`;
}

function installSystemd(userMode: boolean): void {
  if (!checkCommandExists("systemctl")) {
    console.error("Error: systemctl not found. Is systemd installed?");
    process.exit(1);
  }

  const paths = getServicePaths();
  const servicePath = userMode ? paths.systemdUser : paths.systemdSystem;
  const serviceContent = generateSystemdService(userMode);

  // Check if we need sudo for system-level install
  if (!userMode) {
    console.log("Installing system-level service requires sudo.");
    console.log("Consider using --user flag for user-level service instead.");
  }

  // Create directory if needed
  mkdirSync(dirname(servicePath), { recursive: true });

  // Write service file
  try {
    writeFileSync(servicePath, serviceContent);
  } catch (err) {
    if (!userMode) {
      console.error(
        "Error: Cannot write to system directory. Try with sudo or use --user flag.",
      );
    } else {
      console.error(`Error writing service file: ${err}`);
    }
    process.exit(1);
  }

  // Enable and start service
  const systemctlBase = userMode ? ["systemctl", "--user"] : ["systemctl"];

  console.log("Reloading systemd daemon...");
  const reloadResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "daemon-reload"],
    {
      stdio: "inherit",
    },
  );
  if (reloadResult.status !== 0) {
    console.error("Failed to reload systemd daemon");
    process.exit(1);
  }

  console.log("Enabling mercury service...");
  const enableResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "enable", SERVICE_NAME],
    {
      stdio: "inherit",
    },
  );
  if (enableResult.status !== 0) {
    console.error("Failed to enable service");
    process.exit(1);
  }

  console.log("Starting mercury service...");
  const startResult = spawnSync(
    systemctlBase[0],
    [...systemctlBase.slice(1), "start", SERVICE_NAME],
    {
      stdio: "inherit",
    },
  );
  if (startResult.status !== 0) {
    console.error("Failed to start service");
    process.exit(1);
  }

  console.log("\n✓ Mercury service installed and started");
  console.log(`  Service file: ${servicePath}`);
  console.log(
    `  View logs: journalctl ${userMode ? "--user " : ""}-u mercury -f`,
  );
}

function installLaunchd(): void {
  if (!checkCommandExists("launchctl")) {
    console.error("Error: launchctl not found. Are you on macOS?");
    process.exit(1);
  }

  const paths = getServicePaths();
  const plistContent = generateLaunchdPlist();

  // Create log directory
  mkdirSync(paths.logDir, { recursive: true });

  // Create LaunchAgents directory if needed
  mkdirSync(dirname(paths.launchdPlist), { recursive: true });

  // Unload existing service if present
  if (existsSync(paths.launchdPlist)) {
    spawnSync("launchctl", ["unload", paths.launchdPlist], { stdio: "pipe" });
  }

  // Write plist file
  writeFileSync(paths.launchdPlist, plistContent);

  // Load service
  const loadResult = spawnSync("launchctl", ["load", paths.launchdPlist], {
    stdio: "inherit",
  });
  if (loadResult.status !== 0) {
    console.error("Failed to load service");
    process.exit(1);
  }

  console.log("\n✓ Mercury service installed and started");
  console.log(`  Plist: ${paths.launchdPlist}`);
  console.log(`  Logs: ${paths.logDir}/mercury.log`);
  console.log(`  View logs: tail -f ${paths.logDir}/mercury.log`);
}

function serviceInstallAction(options: { user?: boolean }): void {
  // Verify we're in a mercury project
  const envPath = join(CWD, ".env");
  if (!existsSync(envPath)) {
    console.error("Error: .env file not found in current directory.");
    console.error("Run 'mercury init' first, or cd into your mercury project.");
    process.exit(1);
  }

  const platform = process.platform;

  if (platform === "darwin") {
    installLaunchd();
  } else if (platform === "linux") {
    // Default to user mode unless explicitly installing system-wide
    installSystemd(options.user ?? true);
  } else {
    console.error(`Unsupported platform: ${platform}`);
    console.log("See docs/deployment.md for manual setup instructions.");
    process.exit(1);
  }
}

function serviceUninstallAction(): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    if (existsSync(paths.launchdPlist)) {
      console.log("Unloading mercury service...");
      spawnSync("launchctl", ["unload", paths.launchdPlist], {
        stdio: "inherit",
      });
      unlinkSync(paths.launchdPlist);
      console.log("✓ Mercury service uninstalled");
    } else {
      console.log("Service not installed");
    }
  } else if (platform === "linux") {
    // Try user service first, then system
    if (existsSync(paths.systemdUser)) {
      console.log("Stopping mercury user service...");
      spawnSync("systemctl", ["--user", "stop", SERVICE_NAME], {
        stdio: "inherit",
      });
      console.log("Disabling mercury user service...");
      spawnSync("systemctl", ["--user", "disable", SERVICE_NAME], {
        stdio: "inherit",
      });
      unlinkSync(paths.systemdUser);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
      console.log("✓ Mercury user service uninstalled");
    } else if (existsSync(paths.systemdSystem)) {
      console.log("Stopping mercury system service...");
      spawnSync("systemctl", ["stop", SERVICE_NAME], { stdio: "inherit" });
      console.log("Disabling mercury system service...");
      spawnSync("systemctl", ["disable", SERVICE_NAME], { stdio: "inherit" });
      try {
        unlinkSync(paths.systemdSystem);
      } catch {
        console.error(
          "Error: Cannot remove system service file. Try with sudo.",
        );
        process.exit(1);
      }
      spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
      console.log("✓ Mercury system service uninstalled");
    } else {
      console.log("Service not installed");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

function serviceStatusAction(): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    if (!existsSync(paths.launchdPlist)) {
      console.log("Mercury service is not installed");
      return;
    }
    console.log("Mercury service status:\n");
    spawnSync("launchctl", ["list", LAUNCHD_LABEL], { stdio: "inherit" });
  } else if (platform === "linux") {
    // Try user service first
    if (existsSync(paths.systemdUser)) {
      spawnSync("systemctl", ["--user", "status", SERVICE_NAME], {
        stdio: "inherit",
      });
    } else if (existsSync(paths.systemdSystem)) {
      spawnSync("systemctl", ["status", SERVICE_NAME], { stdio: "inherit" });
    } else {
      console.log("Mercury service is not installed");
    }
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

function serviceLogsAction(options: { follow?: boolean }): void {
  const platform = process.platform;
  const paths = getServicePaths();

  if (platform === "darwin") {
    const logPath = join(paths.logDir, "mercury.log");
    if (!existsSync(logPath)) {
      console.error(`Log file not found: ${logPath}`);
      console.log("The service may not have been started yet.");
      process.exit(1);
    }
    const args = options.follow ? ["-f", logPath] : ["-n", "100", logPath];
    spawnSync("tail", args, { stdio: "inherit" });
  } else if (platform === "linux") {
    // Determine if user or system service
    const isUserService = existsSync(paths.systemdUser);
    const isSystemService = existsSync(paths.systemdSystem);

    if (!isUserService && !isSystemService) {
      console.error("Mercury service is not installed");
      process.exit(1);
    }

    const args = isUserService
      ? ["--user", "-u", SERVICE_NAME]
      : ["-u", SERVICE_NAME];
    if (options.follow) args.push("-f");
    spawnSync("journalctl", args, { stdio: "inherit" });
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }
}

// Service subcommand
const serviceCommand = program
  .command("service")
  .description("Manage Mercury as a system service");

serviceCommand
  .command("install")
  .description("Install Mercury as a system service")
  .option(
    "--user",
    "Install as user service (default on Linux, no sudo required)",
  )
  .action(serviceInstallAction);

serviceCommand
  .command("uninstall")
  .description("Uninstall Mercury service")
  .action(serviceUninstallAction);

serviceCommand
  .command("status")
  .description("Show service status")
  .action(serviceStatusAction);

serviceCommand
  .command("logs")
  .description("View service logs")
  .option("-f, --follow", "Follow log output")
  .action(serviceLogsAction);

// ─── Extension management ─────────────────────────────────────────────────

function getDataDir(): string {
  const envPath = join(CWD, ".env");
  if (existsSync(envPath)) {
    const envVars = loadEnvFile(envPath);
    if (envVars.MERCURY_DATA_DIR) return envVars.MERCURY_DATA_DIR;
  }
  return ".mercury";
}

function getUserExtensionsDir(): string {
  return join(CWD, getDataDir(), "extensions");
}

function getGlobalDir(): string {
  const envPath = join(CWD, ".env");
  if (existsSync(envPath)) {
    const envVars = loadEnvFile(envPath);
    if (envVars.MERCURY_GLOBAL_DIR) return envVars.MERCURY_GLOBAL_DIR;
  }
  return join(CWD, getDataDir(), "global");
}

/**
 * Resolve an extension source to a local directory path.
 *
 * Supports:
 * - Local paths: `./path/to/extension` or `/absolute/path`
 * - npm packages: `npm:<package-name>`
 * - git repos: `git:<url>`
 *
 * For npm/git, downloads to a temp dir and returns that path.
 * Returns { dir, name, cleanup } — call cleanup() to remove temp dirs.
 */
function resolveExtensionSource(source: string): {
  dir: string;
  name: string;
  cleanup: () => void;
} {
  // npm: prefix
  if (source.startsWith("npm:")) {
    const pkg = source.slice(4);
    const name = pkg.includes("/") ? pkg.split("/").pop()! : pkg;
    const tmp = join(tmpdir(), `mercury-ext-npm-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    console.log(`Fetching ${pkg} from npm...`);
    const packResult = spawnSync(
      "npm",
      ["pack", pkg, "--pack-destination", tmp],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: tmp,
      },
    );
    if (packResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to fetch npm package "${pkg}"`);
      console.error(packResult.stderr?.toString().trim());
      process.exit(1);
    }

    // Find the tarball
    const tarballs = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length === 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: npm pack produced no tarball for "${pkg}"`);
      process.exit(1);
    }

    // Extract tarball
    const tarball = join(tmp, tarballs[0]);
    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir, { recursive: true });
    const extractResult = spawnSync(
      "tar",
      ["xzf", tarball, "-C", extractDir, "--strip-components=1"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (extractResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to extract tarball for "${pkg}"`);
      process.exit(1);
    }

    return {
      dir: extractDir,
      name,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  // git: prefix
  if (source.startsWith("git:")) {
    const url = source.slice(4);
    // Accept git:github.com/user/repo or git:https://github.com/user/repo
    const gitUrl = url.startsWith("http") ? url : `https://${url}`;
    const name = basename(gitUrl).replace(/\.git$/, "");
    const tmp = join(tmpdir(), `mercury-ext-git-${Date.now()}`);

    console.log(`Cloning ${gitUrl}...`);
    const cloneResult = spawnSync(
      "git",
      ["clone", "--depth", "1", gitUrl, tmp],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    if (cloneResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      console.error(`Error: failed to clone "${gitUrl}"`);
      console.error(cloneResult.stderr?.toString().trim());
      process.exit(1);
    }

    return {
      dir: tmp,
      name,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  // Local path
  const absPath = resolve(CWD, source);
  if (!existsSync(absPath)) {
    console.error(`Error: path not found: ${source}`);
    process.exit(1);
  }
  if (!existsSync(join(absPath, "index.ts"))) {
    console.error(`Error: no index.ts found in ${source}`);
    process.exit(1);
  }

  const name = basename(absPath);
  return { dir: absPath, name, cleanup: () => {} };
}

/**
 * Validate extension before installation.
 */
function validateExtension(
  name: string,
  sourceDir: string,
  extensionsDir: string,
): void {
  // Name format
  if (!VALID_EXT_NAME_RE.test(name)) {
    console.error(
      `Error: invalid extension name "${name}" (must be lowercase alphanumeric + hyphens)`,
    );
    process.exit(1);
  }

  // Reserved name
  if (RESERVED_EXTENSION_NAMES.has(name)) {
    console.error(`Error: "${name}" is a reserved built-in command name`);
    process.exit(1);
  }

  // index.ts must exist
  if (!existsSync(join(sourceDir, "index.ts"))) {
    console.error(`Error: no index.ts found in extension source`);
    process.exit(1);
  }

  // Already installed
  if (existsSync(join(extensionsDir, name))) {
    console.error(
      `Error: extension "${name}" is already installed. Run 'mercury remove ${name}' first.`,
    );
    process.exit(1);
  }
}

/**
 * Try loading an extension to check for syntax/import errors.
 */
async function dryRunExtension(dir: string, name: string): Promise<void> {
  const indexPath = join(dir, "index.ts");
  try {
    const mod = await import(indexPath);
    if (typeof mod.default !== "function") {
      console.error(`Error: ${name}/index.ts must export a default function`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: failed to load ${name}/index.ts:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Install skill files for a newly added extension.
 */
function installSkillIfPresent(extDir: string, name: string): boolean {
  const skillDir = join(extDir, "skill");
  if (!existsSync(join(skillDir, "SKILL.md"))) return false;

  const globalDir = getGlobalDir();
  const dst = join(globalDir, "skills", name);
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { recursive: true, force: true });
  cpSync(skillDir, dst, { recursive: true });
  return true;
}

/**
 * Read extension metadata by doing a quick dry-run load.
 * Returns partial info for the install report.
 */
async function readExtensionInfo(dir: string): Promise<{
  hasCli: boolean;
  hasSkill: boolean;
  cliName?: string;
  installCmd?: string;
  permissionRoles?: string[];
}> {
  const { MercuryExtensionAPIImpl } = await import("../extensions/api.js");
  const { Db } = await import("../storage/db.js");

  // Create a temporary in-memory DB for dry-run
  const tmpDbPath = join(tmpdir(), `mercury-dryrun-${Date.now()}.db`);
  const db = new Db(tmpDbPath);
  try {
    const name = basename(dir);
    const api = new MercuryExtensionAPIImpl(name, dir, db);
    const mod = await import(join(dir, "index.ts"));
    try {
      mod.default(api);
    } catch {
      // Best-effort — some extensions may fail without full runtime
    }
    const meta = api.getMeta();
    return {
      hasCli: !!meta.cli,
      hasSkill: !!meta.skillDir,
      cliName: meta.cli?.name,
      installCmd: meta.cli?.install,
      permissionRoles: meta.permission?.defaultRoles,
    };
  } finally {
    db.close();
    rmSync(tmpDbPath, { force: true });
  }
}

async function addAction(source: string): Promise<void> {
  const extensionsDir = getUserExtensionsDir();
  mkdirSync(extensionsDir, { recursive: true });

  const { dir: sourceDir, name, cleanup } = resolveExtensionSource(source);

  try {
    // Validate
    validateExtension(name, sourceDir, extensionsDir);

    // Dry-run load to catch errors early
    await dryRunExtension(sourceDir, name);

    // Copy to extensions dir
    const destDir = join(extensionsDir, name);
    cpSync(sourceDir, destDir, { recursive: true });

    // Install dependencies if package.json present
    if (existsSync(join(destDir, "package.json"))) {
      console.log("Installing dependencies...");
      const installResult = spawnSync("bun", ["install"], {
        stdio: "inherit",
        cwd: destDir,
      });
      if (installResult.status !== 0) {
        console.error("Warning: dependency installation failed");
      }
    }

    // Install skill
    const hasSkill = installSkillIfPresent(destDir, name);

    // Read extension info for report
    let info: Awaited<ReturnType<typeof readExtensionInfo>>;
    try {
      info = await readExtensionInfo(destDir);
    } catch {
      info = { hasCli: false, hasSkill: hasSkill };
    }

    // Report
    console.log(`\n✓ Extension "${name}" installed`);
    if (info.hasCli) {
      console.log(`  CLI: ${info.cliName} (available after image rebuild)`);
    }
    if (hasSkill) {
      console.log(`  Skill: ${name} (available to agent)`);
    }
    if (info.permissionRoles) {
      console.log(
        `  Permission: ${name} (default: ${info.permissionRoles.join(", ")})`,
      );
    }

    if (info.hasCli) {
      console.log("\nRebuild the agent image to include the CLI:");
      console.log("  mercury build");
    }

    console.log("\nRestart mercury to activate:");
    console.log("  mercury service restart");
  } catch (err) {
    // Rollback on unexpected error
    const destDir = join(extensionsDir, name);
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }
    throw err;
  } finally {
    cleanup();
  }
}

function removeAction(name: string): void {
  const extensionsDir = getUserExtensionsDir();
  const extDir = join(extensionsDir, name);

  if (!existsSync(extDir)) {
    console.error(`Error: extension "${name}" is not installed`);
    process.exit(1);
  }

  // Remove skill
  const globalDir = getGlobalDir();
  const skillDst = join(globalDir, "skills", name);
  if (existsSync(skillDst)) {
    rmSync(skillDst, { recursive: true });
  }

  // Remove extension
  rmSync(extDir, { recursive: true });

  console.log(`✓ Extension "${name}" removed`);
  console.log("\nRestart mercury to apply:");
  console.log("  mercury service restart");
}

function extensionsListAction(): void {
  const userExtDir = getUserExtensionsDir();
  const builtinExtDir = join(__dirname, "..", "extensions");

  const extensions: Array<{
    name: string;
    features: string[];
    description: string;
    builtin: boolean;
  }> = [];

  // Scan a directory for extensions
  function scanDir(dir: string, builtin: boolean): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!VALID_EXT_NAME_RE.test(name)) continue;
      if (RESERVED_EXTENSION_NAMES.has(name)) continue;

      const extDir = join(dir, name);
      if (!existsSync(join(extDir, "index.ts"))) continue;

      const features: string[] = [];
      if (existsSync(join(extDir, "skill", "SKILL.md"))) features.push("Skill");

      // Read SKILL.md for description
      let description = "";
      const skillMd = join(extDir, "skill", "SKILL.md");
      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const descMatch = content.match(
          /^description:\s*(.+?)(?:\n[a-z]|\n---)/ms,
        );
        if (descMatch) {
          description = descMatch[1].replace(/\n\s*/g, " ").trim();
        }
      }

      extensions.push({ name, features, description, builtin });
    }
  }

  scanDir(userExtDir, false);
  scanDir(builtinExtDir, true);

  if (extensions.length === 0) {
    console.log("No extensions installed.");
    console.log("\nInstall one with:");
    console.log("  mercury add ./path/to/extension");
    console.log("  mercury add npm:<package>");
    console.log("  mercury add git:<repo-url>");
    return;
  }

  // Sort: user extensions first, then built-in, alphabetically within
  extensions.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  // Calculate column widths
  const nameWidth = Math.max(12, ...extensions.map((e) => e.name.length));
  const featWidth = Math.max(
    10,
    ...extensions.map((e) => e.features.join(" + ").length || 3),
  );

  for (const ext of extensions) {
    const features = ext.features.length > 0 ? ext.features.join(" + ") : "—";
    const tag = ext.builtin ? " (built-in)" : "";
    const desc = ext.description
      ? `  ${ext.description.slice(0, 60)}${ext.description.length > 60 ? "…" : ""}`
      : "";
    console.log(
      `${ext.name.padEnd(nameWidth)}  ${features.padEnd(featWidth)}${tag}${desc}`,
    );
  }
}

// Chat command — direct bridge to talk to the running Mercury instance
program
  .command("chat [text...]")
  .description("Send a message to Mercury and get a reply")
  .option("-p, --port <port>", "Mercury server port", "8787")
  .option("-g, --group <groupId>", "Group ID for the conversation")
  .option("--caller <callerId>", "Caller ID", "cli:user")
  .option("--json", "Output raw JSON response")
  .action(
    async (
      textParts: string[],
      options: {
        port: string;
        group?: string;
        caller: string;
        json?: boolean;
      },
    ) => {
      // Read from args or stdin
      let text: string;
      if (textParts.length > 0) {
        text = textParts.join(" ");
      } else if (!process.stdin.isTTY) {
        text = readFileSync("/dev/stdin", "utf-8").trim();
      } else {
        console.error("Usage: mercury chat <message>");
        console.error('       echo "message" | mercury chat');
        process.exit(1);
      }

      if (!text) {
        console.error("Error: empty message");
        process.exit(1);
      }

      const url = `http://localhost:${options.port}/chat`;
      const body: Record<string, string> = {
        text,
        callerId: options.caller,
      };
      if (options.group) body.groupId = options.group;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          console.error(
            `Error: ${(err as { error?: string }).error || res.statusText}`,
          );
          process.exit(1);
        }

        const data = (await res.json()) as {
          reply: string;
          files: Array<{
            filename: string;
            path: string;
            mimeType: string;
            sizeBytes: number;
          }>;
          error?: string;
        };

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.reply) console.log(data.reply);
          if (data.files && data.files.length > 0) {
            console.error(
              `\n[${data.files.length} file(s): ${data.files.map((f) => f.filename).join(", ")}]`,
            );
          }
        }
      } catch (err) {
        if (
          err instanceof TypeError &&
          (err.message.includes("fetch") ||
            err.message.includes("ECONNREFUSED"))
        ) {
          console.error(
            `Error: cannot connect to Mercury at localhost:${options.port}`,
          );
          console.error("Is Mercury running? Try: mercury service status");
        } else {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        process.exit(1);
      }
    },
  );

// Extension commands
program
  .command("add <source>")
  .description("Install an extension (local path, npm:<pkg>, or git:<url>)")
  .action(addAction);

program
  .command("remove <name>")
  .description("Remove an installed extension")
  .action(removeAction);

const extCommand = program
  .command("extensions")
  .alias("ext")
  .description("Manage extensions");

extCommand
  .command("list")
  .description("List installed extensions")
  .action(extensionsListAction);

program.parse();
