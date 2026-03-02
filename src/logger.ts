export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

type LogContext = Record<string, unknown>;

const ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "info").toLowerCase();
  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return normalized;
    default:
      return "info";
  }
}

function parseFormat(value: string | undefined): LogFormat {
  const normalized = (value ?? "text").toLowerCase();
  return normalized === "json" ? "json" : "text";
}

// Configuration - read from env at module load
// Container uses LOG_LEVEL, host uses MERCURY_LOG_LEVEL (then calls configureLogger())
let currentLevel = parseLevel(
  process.env.LOG_LEVEL ?? process.env.MERCURY_LOG_LEVEL,
);
let currentFormat = parseFormat(
  process.env.LOG_FORMAT ?? process.env.MERCURY_LOG_FORMAT,
);

/** Configure logger settings (typically called after config load) */
export function configureLogger(opts: {
  level?: LogLevel;
  format?: LogFormat;
}): void {
  if (opts.level) currentLevel = opts.level;
  if (opts.format) currentFormat = opts.format;
}

function enabled(target: Exclude<LogLevel, "silent">): boolean {
  if (currentLevel === "silent") return false;
  return ORDER[target] >= ORDER[currentLevel];
}

function formatText(
  level: string,
  msg: string,
  context: LogContext,
  extra?: unknown,
): string {
  const ts = new Date().toISOString();
  const levelStr = level.toUpperCase().padEnd(5);

  // Build context string from key=value pairs
  const contextParts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null) {
      contextParts.push(`${key}=${value}`);
    }
  }

  // Handle extra data (flatten if object, stringify otherwise)
  if (extra !== undefined && extra !== null) {
    if (extra instanceof Error) {
      contextParts.push(`error=${extra.message}`);
    } else if (typeof extra === "object") {
      for (const [key, value] of Object.entries(extra as LogContext)) {
        if (value !== undefined && value !== null) {
          contextParts.push(`${key}=${value}`);
        }
      }
    }
  }

  const contextStr =
    contextParts.length > 0 ? ` ${contextParts.join(" ")}` : "";
  return `${ts} [${levelStr}] ${msg}${contextStr}`;
}

function formatJson(
  level: string,
  msg: string,
  context: LogContext,
  extra?: unknown,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...context,
  };

  // Merge extra data
  if (extra !== undefined && extra !== null) {
    if (extra instanceof Error) {
      entry.error = extra.message;
      entry.stack = extra.stack;
    } else if (typeof extra === "object") {
      Object.assign(entry, extra);
    } else {
      entry.extra = extra;
    }
  }

  return JSON.stringify(entry);
}

function format(
  level: string,
  msg: string,
  context: LogContext,
  extra?: unknown,
): string {
  return currentFormat === "json"
    ? formatJson(level, msg, context, extra)
    : formatText(level, msg, context, extra);
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
  child(context: LogContext): Logger;
}

function createLogger(baseContext: LogContext = {}): Logger {
  return {
    get level() {
      return currentLevel;
    },

    debug(msg: string, extra?: unknown) {
      if (enabled("debug")) {
        console.debug(format("debug", msg, baseContext, extra));
      }
    },

    info(msg: string, extra?: unknown) {
      if (enabled("info")) {
        console.log(format("info", msg, baseContext, extra));
      }
    },

    warn(msg: string, extra?: unknown) {
      if (enabled("warn")) {
        console.warn(format("warn", msg, baseContext, extra));
      }
    },

    error(msg: string, extra?: unknown) {
      if (enabled("error")) {
        console.error(format("error", msg, baseContext, extra));
      }
    },

    child(context: LogContext): Logger {
      return createLogger({ ...baseContext, ...context });
    },
  };
}

export const logger = createLogger();
