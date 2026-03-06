import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { EgressFile } from "../types.js";
import { extToMime } from "./media.js";

/** Default max file size for outbox files (25 MB) */
const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;

/**
 * Scan outbox/ for files created or modified during a container run.
 *
 * Files with mtime >= startTimeMs are considered new or modified.
 * Skips dotfiles, directories, and files exceeding maxSizeBytes.
 * Non-recursive (one level only).
 */
export function scanOutbox(
  workspacePath: string,
  startTimeMs: number,
  maxSizeBytes = DEFAULT_MAX_FILE_SIZE,
): EgressFile[] {
  const outboxDir = path.join(workspacePath, "outbox");

  if (!fs.existsSync(outboxDir)) return [];

  const files: EgressFile[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(outboxDir, { withFileTypes: true });
  } catch (error) {
    logger.warn("Failed to read outbox directory", {
      outboxDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;

    const filePath = path.join(outboxDir, entry.name);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      logger.warn("Failed to stat outbox file, skipping", {
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (stat.mtimeMs < startTimeMs) continue;

    if (stat.size > maxSizeBytes) {
      logger.warn("Outbox file exceeds max size, skipping", {
        path: filePath,
        sizeBytes: stat.size,
        maxSizeBytes,
      });
      continue;
    }

    files.push({
      path: filePath,
      filename: entry.name,
      mimeType: extToMime(entry.name),
      sizeBytes: stat.size,
    });
  }

  return files;
}
