#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { kbDistill } from "./kb-distill.js";
import { authenticate } from "./whatsapp-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "../..");
const CWD = process.cwd();
const TEMPLATES_DIR = join(PACKAGE_ROOT, "resources/templates");

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
  copySourceFile("src/cli/mercury-ctl.ts", "src/cli/mercury-ctl.ts");
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

  const imageCheck = spawnSync(
    "docker",
    ["image", "inspect", "mercury-agent:latest"],
    {
      stdio: "pipe",
    },
  );
  if (imageCheck.status !== 0) {
    console.error("Error: Container image 'mercury-agent:latest' not found.");
    console.error("Run 'mercury build' to build it.");
    process.exit(1);
  }

  const envVars = loadEnvFile(envPath);

  console.log("🪽 Starting mercury...\n");

  const entryPoint = join(PACKAGE_ROOT, "src/chat-sdk.ts");

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

program.parse();
