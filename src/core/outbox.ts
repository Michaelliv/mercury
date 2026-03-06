import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type { EgressFile } from "../types.js";

/** Default max file size for outbox files (25 MB) */
const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;

/** Extension → MIME type (inline, replaced by shared utility in #98) */
const EXT_TO_MIME: Record<string, string> = {
  // Images
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Audio
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  // Video
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  webm: "video/webm",
  // Documents
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  md: "text/markdown",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Detect MIME type from filename extension */
export function detectMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

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
      mimeType: detectMimeType(entry.name),
      sizeBytes: stat.size,
    });
  }

  return files;
}
