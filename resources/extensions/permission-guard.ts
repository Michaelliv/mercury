/**
 * Mercury Permission Guard — pi extension (runs inside container)
 *
 * Blocks direct bash invocation of extension CLIs that the caller
 * doesn't have permission to use. This prevents bypassing Mercury's
 * RBAC by calling CLIs directly instead of through `mrctl`.
 *
 * Reads MERCURY_DENIED_CLIS env var — comma-separated list of CLI
 * names the current caller is NOT allowed to use.
 *
 * Set automatically by Mercury's runtime based on caller permissions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const deniedEnv = process.env.MERCURY_DENIED_CLIS;
  if (!deniedEnv) return;

  const denied = deniedEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (denied.length === 0) return;

  // Build a single regex that matches any denied CLI name in command position.
  // Command position = start of string, or after ; & | && || ` $ ( or newline.
  const names = denied.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const joined = names.join("|");
  const pattern = new RegExp(`(?:^|[;&|$\`()\\n])\\s*(?:${joined})(?:\\s|$|&)`);

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const command = (event.input.command as string).trim();
    if (!pattern.test(command)) return undefined;

    // Find which CLI matched for the error message
    const matched = denied.find((name) => {
      const single = new RegExp(
        `(?:^|[;&|$\`()\\n])\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$|&)`,
      );
      return single.test(command);
    });

    return {
      block: true,
      reason: `Permission denied: "${matched}" is not available to you in this space. Do not attempt to bypass this by using full paths, aliases, symlinks, or any other workaround. Tell the user they don't have permission to use "${matched}".`,
    };
  });
}
