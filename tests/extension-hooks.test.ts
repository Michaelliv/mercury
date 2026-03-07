import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { resetPermissions } from "../src/core/permissions.js";
import { HookDispatcher } from "../src/extensions/hooks.js";
import { ExtensionRegistry } from "../src/extensions/loader.js";
import type { MercuryExtensionContext } from "../src/extensions/types.js";
import { Db } from "../src/storage/db.js";

const testGlobals = globalThis as Record<string, unknown>;

let tmpDir: string;
let db: Db;
let extDir: string;
let registry: ExtensionRegistry;
let dispatcher: HookDispatcher;
let ctx: MercuryExtensionContext;

const log = {
  level: "info" as const,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mercury-hooks-"));
  db = new Db(path.join(tmpDir, "state.db"));
  extDir = path.join(tmpDir, "extensions");
  fs.mkdirSync(extDir);
  registry = new ExtensionRegistry();
  dispatcher = new HookDispatcher(registry, log);
  resetPermissions();
  ctx = { db, config: {} as AppConfig, log };
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeExt(name: string, code: string) {
  const dir = path.join(extDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), code);
}

describe("HookDispatcher — non-mutating events", () => {
  it("emits startup to all handlers", async () => {
    writeExt(
      "ext-a",
      `export default function(m) {
				m.on("startup", async () => { globalThis.__hookA = true; });
			}`,
    );
    writeExt(
      "ext-b",
      `export default function(m) {
				m.on("startup", async () => { globalThis.__hookB = true; });
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    await dispatcher.emit("startup", {}, ctx);
    expect(testGlobals.__hookA).toBe(true);
    expect(testGlobals.__hookB).toBe(true);

    delete testGlobals.__hookA;
    delete testGlobals.__hookB;
  });

  it("emits workspace_init with event data", async () => {
    writeExt(
      "ws-ext",
      `export default function(m) {
				m.on("workspace_init", async (event) => {
					globalThis.__wsEvent = event;
				});
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    await dispatcher.emit(
      "workspace_init",
      { spaceId: "g1", workspace: "/tmp/ws", containerWorkspace: "/spaces/g1" },
      ctx,
    );
    expect(testGlobals.__wsEvent).toEqual({
      spaceId: "g1",
      workspace: "/tmp/ws",
      containerWorkspace: "/spaces/g1",
    });
    delete testGlobals.__wsEvent;
  });

  it("continues after handler error", async () => {
    writeExt(
      "bad",
      `export default function(m) {
				m.on("startup", async () => { throw new Error("boom"); });
			}`,
    );
    writeExt(
      "good",
      `export default function(m) {
				m.on("startup", async () => { globalThis.__afterBad = true; });
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    // Should not throw
    await dispatcher.emit("startup", {}, ctx);
    expect(testGlobals.__afterBad).toBe(true);
    delete testGlobals.__afterBad;
  });

  it("runs all registered handlers", async () => {
    writeExt(
      "ext-a",
      `export default function(m) {
				m.on("startup", async () => {
					if (!globalThis.__order) globalThis.__order = [];
					globalThis.__order.push("a");
				});
			}`,
    );
    writeExt(
      "ext-b",
      `export default function(m) {
				m.on("startup", async () => {
					if (!globalThis.__order) globalThis.__order = [];
					globalThis.__order.push("b");
				});
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    await dispatcher.emit("startup", {}, ctx);
    // Both handlers ran (order depends on filesystem readdir)
    expect(testGlobals.__order).toHaveLength(2);
    expect(testGlobals.__order).toContain("a");
    expect(testGlobals.__order).toContain("b");
    delete testGlobals.__order;
  });

  it("no handlers is a no-op", async () => {
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);
    // Should not throw
    await dispatcher.emit("startup", {}, ctx);
    await dispatcher.emit("shutdown", {}, ctx);
  });
});

describe("HookDispatcher — before_container", () => {
  it("returns undefined when no handlers", async () => {
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when handlers return nothing", async () => {
    writeExt(
      "noop",
      `export default function(m) {
				m.on("before_container", async () => undefined);
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("collects systemPrompt from single handler", async () => {
    writeExt(
      "prompt-ext",
      `export default function(m) {
				m.on("before_container", async () => ({
					systemPrompt: "Be helpful",
				}));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result?.systemPrompt).toBe("Be helpful");
  });

  it("concatenates systemPrompt from multiple handlers", async () => {
    writeExt(
      "ext-a",
      `export default function(m) {
				m.on("before_container", async () => ({ systemPrompt: "Part A" }));
			}`,
    );
    writeExt(
      "ext-b",
      `export default function(m) {
				m.on("before_container", async () => ({ systemPrompt: "Part B" }));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    // Both parts present (order depends on filesystem readdir)
    expect(result?.systemPrompt).toContain("Part A");
    expect(result?.systemPrompt).toContain("Part B");
  });

  it("merges env vars from multiple handlers", async () => {
    writeExt(
      "ext-a",
      `export default function(m) {
				m.on("before_container", async () => ({
					env: { ONLY_A: "yes" },
				}));
			}`,
    );
    writeExt(
      "ext-b",
      `export default function(m) {
				m.on("before_container", async () => ({
					env: { ONLY_B: "yes" },
				}));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result?.env?.ONLY_A).toBe("yes");
    expect(result?.env?.ONLY_B).toBe("yes");
  });

  it("block stops the chain immediately", async () => {
    writeExt(
      "blocker",
      `export default function(m) {
				m.on("before_container", async () => ({
					block: { reason: "Rate limited" },
				}));
			}`,
    );
    writeExt(
      "never-runs",
      `export default function(m) {
				m.on("before_container", async () => {
					globalThis.__shouldNotRun = true;
					return { systemPrompt: "should not appear" };
				});
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result?.block).toEqual({ reason: "Rate limited" });
    expect(result?.systemPrompt).toBeUndefined();
    expect(testGlobals.__shouldNotRun).toBeUndefined();
  });

  it("handler error is caught, other handlers still run", async () => {
    writeExt(
      "bad-hook",
      `export default function(m) {
				m.on("before_container", async () => { throw new Error("fail"); });
			}`,
    );
    writeExt(
      "good-hook",
      `export default function(m) {
				m.on("before_container", async () => ({ systemPrompt: "survived" }));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitBeforeContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        callerId: "user1",
        workspace: "/tmp",
        containerWorkspace: "/spaces/g1",
      },
      ctx,
    );
    expect(result?.systemPrompt).toBe("survived");
  });
});

describe("HookDispatcher — after_container", () => {
  it("returns undefined when no handlers", async () => {
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitAfterContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        reply: "world",
        durationMs: 100,
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });

  it("handler can replace reply", async () => {
    writeExt(
      "replacer",
      `export default function(m) {
				m.on("after_container", async () => ({ reply: "replaced" }));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitAfterContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        reply: "original",
        durationMs: 100,
      },
      ctx,
    );
    expect(result?.reply).toBe("replaced");
  });

  it("any handler can suppress", async () => {
    writeExt(
      "suppressor",
      `export default function(m) {
				m.on("after_container", async () => ({ suppress: true }));
			}`,
    );
    writeExt(
      "other",
      `export default function(m) {
				m.on("after_container", async () => ({ reply: "modified" }));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitAfterContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        reply: "original",
        durationMs: 100,
      },
      ctx,
    );
    expect(result?.suppress).toBe(true);
    // reply from second handler is still collected
    expect(result?.reply).toBe("modified");
  });

  it("handler error is caught, other handlers still run", async () => {
    writeExt(
      "bad-after",
      `export default function(m) {
				m.on("after_container", async () => { throw new Error("fail"); });
			}`,
    );
    writeExt(
      "good-after",
      `export default function(m) {
				m.on("after_container", async () => ({ reply: "survived" }));
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitAfterContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        reply: "original",
        durationMs: 100,
      },
      ctx,
    );
    expect(result?.reply).toBe("survived");
  });

  it("returns undefined when handlers return nothing", async () => {
    writeExt(
      "noop-after",
      `export default function(m) {
				m.on("after_container", async () => undefined);
			}`,
    );
    await registry.loadAll(extDir, db, log);
    dispatcher = new HookDispatcher(registry, log);

    const result = await dispatcher.emitAfterContainer(
      {
        spaceId: "g1",
        prompt: "hello",
        reply: "original",
        durationMs: 100,
      },
      ctx,
    );
    expect(result).toBeUndefined();
  });
});
