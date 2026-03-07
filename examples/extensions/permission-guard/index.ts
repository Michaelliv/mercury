/**
 * Mercury Permission Guard — pi extension
 *
 * Prevents the agent from bypassing RBAC by calling extension CLIs
 * directly in bash. Forces all extension CLI calls through `mrctl`,
 * which checks permissions via the Mercury API.
 *
 * Environment variables:
 *   MERCURY_EXT_CLIS — comma-separated list of extension CLI names
 *                      e.g. "pinchtab,napkin,charts,pdf"
 *
 * Without this extension, the agent can call `pinchtab search foo`
 * directly in bash, bypassing the permission check that `mrctl pinchtab
 * search foo` would enforce.
 *
 * Behavior: intercepts bash tool calls that invoke an extension CLI
 * directly and blocks them with a message to use `mrctl` instead.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const extClisEnv = process.env.MERCURY_EXT_CLIS;
  if (!extClisEnv) return;

  const extClis = extClisEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (extClis.length === 0) return;

  // Match CLI name as the first command word, or after shell operators
  // Covers: `pinchtab args`, `cd /tmp && pinchtab args`, `pinchtab &`
  const cliPatterns = extClis.map((name) => ({
    name,
    pattern: new RegExp(
      `(?:^|&&|\\|\\||;|\\|)\\s*${escapeRegex(name)}(?:\\s|$|&)`,
    ),
  }));

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const command = (event.input.command as string).trim();

    // Don't block if already going through mrctl
    if (/(?:^|&&|\|\||;|\|)\s*mrctl\s/.test(command)) return undefined;

    for (const { name, pattern } of cliPatterns) {
      if (pattern.test(command)) {
        return {
          block: true,
          reason: `Direct "${name}" calls are not allowed. Use "mrctl ${name} ..." instead, which enforces permissions.`,
        };
      }
    }

    return undefined;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
