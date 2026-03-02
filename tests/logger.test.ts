import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// We need to test the logger in isolation, so we'll import and configure it
// Reset module state between tests by re-importing

describe("logger", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleDebug: ReturnType<typeof mock>;
  let consoleLog: ReturnType<typeof mock>;
  let consoleWarn: ReturnType<typeof mock>;
  let consoleError: ReturnType<typeof mock>;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };

    // Mock console methods
    consoleDebug = mock(() => {});
    consoleLog = mock(() => {});
    consoleWarn = mock(() => {});
    consoleError = mock(() => {});

    console.debug = consoleDebug;
    console.log = consoleLog;
    console.warn = consoleWarn;
    console.error = consoleError;
  });

  afterEach(() => {
    // Restore env
    process.env = originalEnv;
  });

  test("text format outputs structured text", async () => {
    // Set up env before import
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "text";

    // Clear module cache and re-import
    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "text" });

    logger.info("Test message", { key: "value" });

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const output = consoleLog.mock.calls[0][0] as string;

    // Should contain ISO timestamp
    expect(output).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Should contain level
    expect(output).toContain("[INFO ]");
    // Should contain message
    expect(output).toContain("Test message");
    // Should contain context
    expect(output).toContain("key=value");
  });

  test("json format outputs valid JSON", async () => {
    process.env.LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "json";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "json" });

    logger.info("Test message", { key: "value" });

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const output = consoleLog.mock.calls[0][0] as string;

    const parsed = JSON.parse(output);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("Test message");
    expect(parsed.key).toBe("value");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("child logger inherits and extends context", async () => {
    process.env.LOG_FORMAT = "json";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "json" });

    const childLogger = logger.child({ groupId: "group-123" });
    childLogger.info("Child log", { extra: "data" });

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const output = consoleLog.mock.calls[0][0] as string;

    const parsed = JSON.parse(output);
    expect(parsed.msg).toBe("Child log");
    expect(parsed.groupId).toBe("group-123");
    expect(parsed.extra).toBe("data");
  });

  test("child logger can be nested", async () => {
    process.env.LOG_FORMAT = "json";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "json" });

    const childLogger = logger
      .child({ groupId: "group-123" })
      .child({ userId: "user-456" });

    childLogger.info("Nested child log");

    const output = consoleLog.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.groupId).toBe("group-123");
    expect(parsed.userId).toBe("user-456");
  });

  test("log level filtering works", async () => {
    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "warn", format: "text" });

    logger.debug("Debug message");
    logger.info("Info message");
    logger.warn("Warn message");
    logger.error("Error message");

    expect(consoleDebug).toHaveBeenCalledTimes(0);
    expect(consoleLog).toHaveBeenCalledTimes(0);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test("silent level suppresses all logs", async () => {
    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "silent", format: "text" });

    logger.debug("Debug");
    logger.info("Info");
    logger.warn("Warn");
    logger.error("Error");

    expect(consoleDebug).toHaveBeenCalledTimes(0);
    expect(consoleLog).toHaveBeenCalledTimes(0);
    expect(consoleWarn).toHaveBeenCalledTimes(0);
    expect(consoleError).toHaveBeenCalledTimes(0);
  });

  test("error objects are handled in JSON format", async () => {
    process.env.LOG_FORMAT = "json";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "json" });

    const err = new Error("Test error");
    logger.error("Something failed", err);

    const output = consoleError.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);

    expect(parsed.msg).toBe("Something failed");
    expect(parsed.error).toBe("Test error");
    expect(parsed.stack).toContain("Error: Test error");
  });

  test("error objects are handled in text format", async () => {
    process.env.LOG_FORMAT = "text";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "text" });

    const err = new Error("Test error");
    logger.error("Something failed", err);

    const output = consoleError.mock.calls[0][0] as string;

    expect(output).toContain("Something failed");
    expect(output).toContain("error=Test error");
  });

  test("text format includes context from child logger", async () => {
    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "text" });

    const childLogger = logger.child({
      groupId: "abc123",
      container: "mercury-123-1",
    });

    childLogger.info("Container started");

    const output = consoleLog.mock.calls[0][0] as string;

    expect(output).toContain("Container started");
    expect(output).toContain("groupId=abc123");
    expect(output).toContain("container=mercury-123-1");
  });

  test("debug level enables all logs", async () => {
    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "debug", format: "text" });

    logger.debug("Debug message");
    logger.info("Info message");
    logger.warn("Warn message");
    logger.error("Error message");

    expect(consoleDebug).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test("container lifecycle log format (JSON)", async () => {
    process.env.LOG_FORMAT = "json";

    delete require.cache[require.resolve("../src/logger.js")];
    const { logger, configureLogger } = await import("../src/logger.js");
    configureLogger({ level: "info", format: "json" });

    const containerLog = logger.child({
      groupId: "abc123",
      container: "mercury-1705312200-1",
    });

    containerLog.info("Container started", { event: "container.start" });

    const startOutput = consoleLog.mock.calls[0][0] as string;
    const startParsed = JSON.parse(startOutput);

    expect(startParsed.msg).toBe("Container started");
    expect(startParsed.groupId).toBe("abc123");
    expect(startParsed.container).toBe("mercury-1705312200-1");
    expect(startParsed.event).toBe("container.start");

    containerLog.info("Container exited", {
      event: "container.end",
      exitCode: 0,
      durationMs: 5000,
    });

    const endOutput = consoleLog.mock.calls[1][0] as string;
    const endParsed = JSON.parse(endOutput);

    expect(endParsed.msg).toBe("Container exited");
    expect(endParsed.exitCode).toBe(0);
    expect(endParsed.durationMs).toBe(5000);
    expect(endParsed.event).toBe("container.end");
  });
});
