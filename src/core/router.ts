import type { AppConfig } from "../config.js";
import type { Db } from "../storage/db.js";
import type { Permission } from "./permissions.js";
import { hasPermission, resolveRole } from "./permissions.js";
import { loadTriggerConfig, matchTrigger } from "./trigger.js";

export type RouteResult =
  | { type: "assistant"; prompt: string; callerId: string; role: string }
  | { type: "command"; command: string; callerId: string; role: string }
  | { type: "denied"; reason: string }
  | { type: "ignore" };

/**
 * Chat-level commands that bypass the LLM.
 * Mapped to the permission required to execute them.
 */
const CHAT_COMMANDS: Record<string, Permission> = {
  stop: "stop",
  compact: "compact",
};

export function routeInput(input: {
  rawText: string;
  groupId: string;
  callerId: string;
  isDM: boolean;
  isReplyToBot?: boolean;
  db: Db;
  config: AppConfig;
}): RouteResult {
  const text = input.rawText.trim();
  if (!text) return { type: "ignore" };

  const seededAdmins = input.config.admins
    ? input.config.admins
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  input.db.ensureGroup(input.groupId);

  // Resolve role (seeds admins + auto-upserts member)
  const role = resolveRole(
    input.db,
    input.groupId,
    input.callerId,
    seededAdmins,
  );

  // Load trigger config for this group
  const defaultPatterns = input.config.triggerPatterns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const triggerConfig = loadTriggerConfig(input.db, input.groupId, {
    patterns: defaultPatterns,
    match: input.config.triggerMatch,
  });

  // Match trigger OR reply-to-bot
  const result = matchTrigger(text, triggerConfig, input.isDM);
  const isReplyTrigger = input.isReplyToBot && !input.isDM;
  if (!result.matched && !isReplyTrigger) return { type: "ignore" };

  // Use stripped prompt if trigger matched, otherwise full text for replies
  const prompt = result.matched ? result.prompt : text;

  // Check for commands after trigger (e.g. "@Pi stop", "Pi compact")
  const cmdWord = prompt.toLowerCase().trim();
  if (cmdWord in CHAT_COMMANDS) {
    return gateCommand(input.db, input.groupId, cmdWord, role, input.callerId);
  }

  // Check prompt permission
  if (!hasPermission(input.db, input.groupId, role, "prompt")) {
    return {
      type: "denied",
      reason: "You don't have permission to use the agent in this group.",
    };
  }

  return {
    type: "assistant",
    prompt,
    callerId: input.callerId,
    role,
  };
}

function gateCommand(
  db: Db,
  groupId: string,
  command: string,
  role: string,
  callerId: string,
): RouteResult {
  const permission = CHAT_COMMANDS[command];
  if (!permission) return { type: "ignore" };

  if (!hasPermission(db, groupId, role, permission)) {
    return {
      type: "denied",
      reason: `You don't have permission to use '${command}'.`,
    };
  }

  return { type: "command", command, callerId, role };
}
