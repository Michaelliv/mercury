import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  downloadMediaFromUrl,
  extToMime,
  mimeToExt,
  mimeToMediaType,
} from "../src/core/media.js";

// ─── extToMime ──────────────────────────────────────────────────────────

describe("extToMime", () => {
  test("detects common image types", () => {
    expect(extToMime("photo.jpg")).toBe("image/jpeg");
    expect(extToMime("photo.jpeg")).toBe("image/jpeg");
    expect(extToMime("image.png")).toBe("image/png");
    expect(extToMime("anim.gif")).toBe("image/gif");
    expect(extToMime("pic.webp")).toBe("image/webp");
  });

  test("detects audio types", () => {
    expect(extToMime("voice.ogg")).toBe("audio/ogg");
    expect(extToMime("song.mp3")).toBe("audio/mpeg");
    expect(extToMime("track.m4a")).toBe("audio/mp4");
  });

  test("detects video types", () => {
    expect(extToMime("clip.mp4")).toBe("video/mp4");
    expect(extToMime("vid.webm")).toBe("video/webm");
  });

  test("detects document types", () => {
    expect(extToMime("doc.pdf")).toBe("application/pdf");
    expect(extToMime("notes.txt")).toBe("text/plain");
    expect(extToMime("data.csv")).toBe("text/csv");
    expect(extToMime("config.json")).toBe("application/json");
    expect(extToMime("readme.md")).toBe("text/markdown");
  });

  test("falls back to application/octet-stream for unknown", () => {
    expect(extToMime("binary.xyz")).toBe("application/octet-stream");
    expect(extToMime("noext")).toBe("application/octet-stream");
  });

  test("is case-insensitive", () => {
    expect(extToMime("PHOTO.JPG")).toBe("image/jpeg");
    expect(extToMime("Doc.PDF")).toBe("application/pdf");
  });
});

// ─── mimeToExt ──────────────────────────────────────────────────────────

describe("mimeToExt", () => {
  test("converts common MIME types", () => {
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("audio/ogg")).toBe("ogg");
    expect(mimeToExt("video/mp4")).toBe("mp4");
    expect(mimeToExt("application/pdf")).toBe("pdf");
  });

  test("handles MIME types with parameters", () => {
    expect(mimeToExt("audio/ogg; codecs=opus")).toBe("ogg");
    expect(mimeToExt("text/plain; charset=utf-8")).toBe("txt");
  });

  test("falls back to bin for unknown MIME types", () => {
    expect(mimeToExt("application/x-custom")).toBe("bin");
    expect(mimeToExt("something/weird")).toBe("bin");
  });
});

// ─── mimeToMediaType ────────────────────────────────────────────────────

describe("mimeToMediaType", () => {
  test("classifies image types", () => {
    expect(mimeToMediaType("image/jpeg")).toBe("image");
    expect(mimeToMediaType("image/png")).toBe("image");
    expect(mimeToMediaType("image/webp")).toBe("image");
  });

  test("classifies audio types", () => {
    expect(mimeToMediaType("audio/ogg")).toBe("audio");
    expect(mimeToMediaType("audio/mpeg")).toBe("audio");
    expect(mimeToMediaType("audio/ogg; codecs=opus")).toBe("audio");
  });

  test("classifies video types", () => {
    expect(mimeToMediaType("video/mp4")).toBe("video");
    expect(mimeToMediaType("video/webm")).toBe("video");
  });

  test("classifies everything else as document", () => {
    expect(mimeToMediaType("application/pdf")).toBe("document");
    expect(mimeToMediaType("text/plain")).toBe("document");
    expect(mimeToMediaType("application/octet-stream")).toBe("document");
  });
});

// ─── downloadMediaFromUrl ───────────────────────────────────────────────

let tmpDir: string;
let server: http.Server;
let serverPort: number;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-media-test-"));
});

afterEach(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve(serverPort);
    });
  });
}

describe("downloadMediaFromUrl", () => {
  test("downloads file to output directory", async () => {
    const content = "fake image data";
    const port = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": content.length.toString(),
      });
      res.end(content);
    });

    const result = await downloadMediaFromUrl(
      `http://localhost:${port}/image.png`,
      {
        type: "image",
        mimeType: "image/png",
        filename: "photo.png",
        maxSizeBytes: 1024 * 1024,
        outputDir: tmpDir,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe("image");
    expect(result!.mimeType).toBe("image/png");
    expect(result!.sizeBytes).toBe(content.length);
    expect(fs.existsSync(result!.path)).toBe(true);
    expect(fs.readFileSync(result!.path, "utf8")).toBe(content);
  });

  test("skips file exceeding expected size", async () => {
    const result = await downloadMediaFromUrl("http://localhost:1/nope", {
      type: "image",
      mimeType: "image/png",
      expectedSizeBytes: 100,
      maxSizeBytes: 50,
      outputDir: tmpDir,
    });

    expect(result).toBeNull();
  });

  test("skips file exceeding Content-Length", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": "999999",
      });
      res.end("tiny");
    });

    const result = await downloadMediaFromUrl(
      `http://localhost:${port}/big.png`,
      {
        type: "image",
        mimeType: "image/png",
        maxSizeBytes: 100,
        outputDir: tmpDir,
      },
    );

    expect(result).toBeNull();
  });

  test("skips file exceeding max size after download", async () => {
    const bigContent = "x".repeat(200);
    const port = await startServer((_req, res) => {
      // No Content-Length header — size unknown until download
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(bigContent);
    });

    const result = await downloadMediaFromUrl(
      `http://localhost:${port}/big.png`,
      {
        type: "image",
        mimeType: "image/png",
        maxSizeBytes: 100,
        outputDir: tmpDir,
      },
    );

    expect(result).toBeNull();
  });

  test("returns null on HTTP error", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("Not found");
    });

    const result = await downloadMediaFromUrl(
      `http://localhost:${port}/missing.png`,
      {
        type: "image",
        mimeType: "image/png",
        maxSizeBytes: 1024 * 1024,
        outputDir: tmpDir,
      },
    );

    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    const result = await downloadMediaFromUrl("http://localhost:1/will-fail", {
      type: "image",
      mimeType: "image/png",
      maxSizeBytes: 1024 * 1024,
      outputDir: tmpDir,
    });

    expect(result).toBeNull();
  });

  test("passes auth headers", async () => {
    let receivedAuth = "";
    const port = await startServer((req, res) => {
      receivedAuth = req.headers.authorization || "";
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    await downloadMediaFromUrl(`http://localhost:${port}/file`, {
      type: "document",
      mimeType: "text/plain",
      maxSizeBytes: 1024,
      outputDir: tmpDir,
      headers: { Authorization: "Bearer xoxb-test-token" },
    });

    expect(receivedAuth).toBe("Bearer xoxb-test-token");
  });

  test("generates timestamped filename without original name", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end("data");
    });

    const result = await downloadMediaFromUrl(`http://localhost:${port}/img`, {
      type: "image",
      mimeType: "image/jpeg",
      maxSizeBytes: 1024,
      outputDir: tmpDir,
    });

    expect(result).not.toBeNull();
    // Filename should be {timestamp}-image.jpg
    expect(result!.path).toMatch(/\d+-image\.jpg$/);
  });

  test("creates output directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "inbox");
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hi");
    });

    const result = await downloadMediaFromUrl(
      `http://localhost:${port}/file.txt`,
      {
        type: "document",
        mimeType: "text/plain",
        filename: "file.txt",
        maxSizeBytes: 1024,
        outputDir: nestedDir,
      },
    );

    expect(result).not.toBeNull();
    expect(fs.existsSync(nestedDir)).toBe(true);
  });
});
