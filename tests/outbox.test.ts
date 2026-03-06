import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMimeType, scanOutbox } from "../src/core/outbox.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-outbox-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scanOutbox", () => {
  test("returns empty array when outbox/ does not exist", () => {
    const files = scanOutbox(tmpDir, Date.now());
    expect(files).toEqual([]);
  });

  test("returns empty array when outbox/ is empty", () => {
    fs.mkdirSync(path.join(tmpDir, "outbox"));
    const files = scanOutbox(tmpDir, Date.now() - 1000);
    expect(files).toEqual([]);
  });

  test("returns files with mtime >= startTime", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    const startTime = Date.now();

    // Write a file after startTime
    const filePath = path.join(outboxDir, "chart.png");
    fs.writeFileSync(filePath, "fake png data");

    const files = scanOutbox(tmpDir, startTime);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("chart.png");
    expect(files[0].mimeType).toBe("image/png");
    expect(files[0].path).toBe(filePath);
    expect(files[0].sizeBytes).toBeGreaterThan(0);
  });

  test("skips files with mtime < startTime", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    // Write a file
    const filePath = path.join(outboxDir, "old-file.txt");
    fs.writeFileSync(filePath, "old content");

    // Set mtime to the past
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(filePath, pastTime, pastTime);

    const files = scanOutbox(tmpDir, Date.now());
    expect(files).toEqual([]);
  });

  test("returns modified files from current run", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    // Write a file in the past
    const filePath = path.join(outboxDir, "report.pdf");
    fs.writeFileSync(filePath, "old content");
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(filePath, pastTime, pastTime);

    const startTime = Date.now();

    // Modify it (mtime updates)
    fs.writeFileSync(filePath, "updated content");

    const files = scanOutbox(tmpDir, startTime);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("report.pdf");
  });

  test("skips dotfiles", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    const startTime = Date.now();
    fs.writeFileSync(path.join(outboxDir, ".hidden"), "secret");
    fs.writeFileSync(path.join(outboxDir, "visible.txt"), "hello");

    const files = scanOutbox(tmpDir, startTime);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("visible.txt");
  });

  test("skips directories", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    const startTime = Date.now();
    fs.mkdirSync(path.join(outboxDir, "subdir"));
    fs.writeFileSync(path.join(outboxDir, "file.txt"), "data");

    const files = scanOutbox(tmpDir, startTime);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("file.txt");
  });

  test("skips files exceeding max size", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    const startTime = Date.now();

    // Write a file that exceeds the max size (set to 10 bytes for test)
    fs.writeFileSync(path.join(outboxDir, "huge.bin"), "x".repeat(100));
    fs.writeFileSync(path.join(outboxDir, "small.txt"), "ok");

    const files = scanOutbox(tmpDir, startTime, 10);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("small.txt");
  });

  test("returns multiple new files", () => {
    const outboxDir = path.join(tmpDir, "outbox");
    fs.mkdirSync(outboxDir);

    const startTime = Date.now();
    fs.writeFileSync(path.join(outboxDir, "a.png"), "img");
    fs.writeFileSync(path.join(outboxDir, "b.pdf"), "doc");
    fs.writeFileSync(path.join(outboxDir, "c.json"), "{}");

    const files = scanOutbox(tmpDir, startTime);
    expect(files).toHaveLength(3);

    const names = files.map((f) => f.filename).sort();
    expect(names).toEqual(["a.png", "b.pdf", "c.json"]);
  });
});

describe("detectMimeType", () => {
  test("detects common image types", () => {
    expect(detectMimeType("photo.jpg")).toBe("image/jpeg");
    expect(detectMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(detectMimeType("image.png")).toBe("image/png");
    expect(detectMimeType("anim.gif")).toBe("image/gif");
    expect(detectMimeType("pic.webp")).toBe("image/webp");
  });

  test("detects audio types", () => {
    expect(detectMimeType("voice.ogg")).toBe("audio/ogg");
    expect(detectMimeType("song.mp3")).toBe("audio/mpeg");
  });

  test("detects video types", () => {
    expect(detectMimeType("clip.mp4")).toBe("video/mp4");
  });

  test("detects document types", () => {
    expect(detectMimeType("doc.pdf")).toBe("application/pdf");
    expect(detectMimeType("notes.txt")).toBe("text/plain");
    expect(detectMimeType("data.csv")).toBe("text/csv");
    expect(detectMimeType("config.json")).toBe("application/json");
    expect(detectMimeType("readme.md")).toBe("text/markdown");
  });

  test("falls back to application/octet-stream for unknown", () => {
    expect(detectMimeType("binary.xyz")).toBe("application/octet-stream");
    expect(detectMimeType("noext")).toBe("application/octet-stream");
  });

  test("handles case insensitivity via lowercase", () => {
    expect(detectMimeType("PHOTO.JPG")).toBe("image/jpeg");
    expect(detectMimeType("Doc.PDF")).toBe("application/pdf");
  });
});
