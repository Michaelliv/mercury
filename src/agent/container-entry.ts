import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MessageAttachment, StoredMessage } from "../types.js";

type Payload = {
  groupId: string;
  groupWorkspace: string;
  messages: StoredMessage[];
  prompt: string;
  attachments?: MessageAttachment[];
};

const START = "---MERCURY_CONTAINER_RESULT_START---";
const END = "---MERCURY_CONTAINER_RESULT_END---";

function formatContextTimestamp(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function buildSystemPrompt(): string {
  return `You are Mercury, a concise personal AI assistant.
Prioritize practical outputs and explicit assumptions.

## Memory

You have a persistent memory system powered by napkin (Obsidian-compatible vault).
Your workspace is organized with entities/, daily/, and AGENTS.md for persistent instructions.

### Reading memory
- Use \`napkin search "query"\` to find relevant files
- Use \`napkin read "filename"\` to read a specific file
- Use \`napkin link back --file "name"\` to see what links to a file
- Use \`napkin daily read\` to read today's daily note

### Writing memory
- When the user asks you to remember something, write it immediately using napkin.
- For new entities: \`napkin create --name "Entity Name" --path entities --content "..."\`
- For existing entities: \`napkin append --file "Entity Name" --content "..."\`
- For structured facts: \`napkin property set --file "Entity Name" --name key --value "value"\`
- For conversation context: \`napkin daily append --content "..."\`
- For persistent instructions: Edit AGENTS.md directly

### Wikilinks
- Use \`[[Like This]]\` when mentioning people, places, projects, or concepts
- Pages are cheap — if in doubt, link it
- napkin resolves wikilinks automatically

### What to remember
- Everything the user explicitly asks you to remember
- Context needed to continue the conversation tomorrow
- Don't filter by "importance" — if it came up, it may matter later`;
}

/**
 * Format attachment information for the prompt as XML.
 * Converts absolute paths to container-relative paths.
 */
function formatAttachments(
  attachments: MessageAttachment[] | undefined,
): string | null {
  if (!attachments || attachments.length === 0) return null;

  const entries = attachments.map((att) => {
    // Convert host path to container path
    const containerPath = att.path.replace(/^.*\/groups\//, "/groups/");

    const attrs = [
      `type="${att.type}"`,
      `path="${containerPath}"`,
      `mime="${att.mimeType}"`,
    ];

    if (att.sizeBytes) {
      attrs.push(`size="${att.sizeBytes}"`);
    }
    if (att.filename) {
      attrs.push(`filename="${att.filename}"`);
    }

    return `  <attachment ${attrs.join(" ")} />`;
  });

  return ["<attachments>", ...entries, "</attachments>"].join("\n");
}

function buildPrompt(payload: Payload): string {
  const parts: string[] = [];

  // Add ambient messages context
  const ambientEntries = payload.messages
    .filter((m) => m.role === "ambient")
    .map((m) => {
      const ts = formatContextTimestamp(m.createdAt);
      return `  <message role="group" timestamp="${ts}">\n${m.content}\n  </message>`;
    });

  if (ambientEntries.length > 0) {
    parts.push("<ambient_messages>");
    parts.push(...ambientEntries);
    parts.push("</ambient_messages>");
    parts.push("");
  }

  // Add attachments from current message
  const attachmentsXml = formatAttachments(payload.attachments);
  if (attachmentsXml) {
    parts.push(attachmentsXml);
    parts.push("");
  }

  // Add the prompt
  parts.push(payload.prompt);

  return parts.join("\n");
}

function runPi(payload: Payload): Promise<string> {
  return new Promise((resolve, reject) => {
    const sessionFile = path.join(
      payload.groupWorkspace,
      ".mercury.session.jsonl",
    );

    const args = [
      "--print",
      "--session",
      sessionFile,
      "--provider",
      process.env.MERCURY_MODEL_PROVIDER || "anthropic",
      "--model",
      process.env.MERCURY_MODEL || "claude-opus-4-6",
      "--append-system-prompt",
      buildSystemPrompt(),
      buildPrompt(payload),
    ];

    const proc = spawn("pi", args, {
      cwd: payload.groupWorkspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (error) => reject(error));

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`pi CLI failed (${code}): ${stderr || stdout}`));
        return;
      }
      resolve(stdout.trim() || "Done.");
    });
  });
}

async function main() {
  const input = readFileSync(0, "utf8");
  let payload: Payload;
  try {
    payload = JSON.parse(input) as Payload;
  } catch {
    process.stderr.write("Failed to parse input payload\n");
    process.exit(1);
  }

  const reply = await runPi(payload);

  process.stdout.write(`${START}\n`);
  process.stdout.write(JSON.stringify({ reply }));
  process.stdout.write(`\n${END}\n`);
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
