import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../src/storage/db.js";

describe("extension_state", () => {
  let db: Db;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-ext-store-"));
    db = new Db(path.join(tmpDir, "state.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("get returns null for missing key", () => {
    expect(db.getExtState("napkin", "missing")).toBeNull();
  });

  it("set then get returns value", () => {
    db.setExtState("napkin", "last-run", "123456");
    expect(db.getExtState("napkin", "last-run")).toBe("123456");
  });

  it("set overwrites existing value", () => {
    db.setExtState("napkin", "count", "1");
    db.setExtState("napkin", "count", "2");
    expect(db.getExtState("napkin", "count")).toBe("2");
  });

  it("namespace isolation — two extensions with same key", () => {
    db.setExtState("napkin", "status", "ok");
    db.setExtState("kb-distill", "status", "running");

    expect(db.getExtState("napkin", "status")).toBe("ok");
    expect(db.getExtState("kb-distill", "status")).toBe("running");
  });

  it("delete removes key and returns true", () => {
    db.setExtState("napkin", "tmp", "val");
    expect(db.deleteExtState("napkin", "tmp")).toBe(true);
    expect(db.getExtState("napkin", "tmp")).toBeNull();
  });

  it("delete returns false for missing key", () => {
    expect(db.deleteExtState("napkin", "nope")).toBe(false);
  });

  it("list returns all keys for extension", () => {
    db.setExtState("napkin", "a", "1");
    db.setExtState("napkin", "b", "2");
    db.setExtState("other", "c", "3");

    const items = db.listExtState("napkin");
    expect(items).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("list returns empty array when no keys", () => {
    expect(db.listExtState("empty")).toEqual([]);
  });
});
