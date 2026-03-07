/**
 * Mercury Extension System — Type Definitions
 *
 * All types for the extension API, events, metadata, and supporting structures.
 * No runtime code — types only.
 */

import type { ContainerError } from "../agent/container-error.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { Db } from "../storage/db.js";

// ---------------------------------------------------------------------------
// Extension context — passed to event handlers and job runners
// ---------------------------------------------------------------------------

/** Context available to extension hooks and jobs at runtime. */
export interface MercuryExtensionContext {
  /** Database access. */
  readonly db: Db;
  /** Mercury configuration. */
  readonly config: AppConfig;
  /** Logger scoped to the extension. */
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** All lifecycle events an extension can subscribe to. */
export interface MercuryEvents {
  /** Fired after all extensions are loaded and the runtime is ready. */
  startup: StartupEvent;
  /** Fired when Mercury is shutting down. */
  shutdown: ShutdownEvent;
  /** Fired when a space workspace directory is created or ensured. */
  workspace_init: WorkspaceInitEvent;
  /** Fired just before a container is spawned for a message. */
  before_container: BeforeContainerEvent;
  /** Fired after a container finishes (success or error). */
  after_container: AfterContainerEvent;
}

export type StartupEvent = Record<string, never>;

export type ShutdownEvent = Record<string, never>;

export interface WorkspaceInitEvent {
  /** The space this workspace belongs to. */
  spaceId: string;
  /** Absolute path to the workspace directory. */
  workspace: string;
  /** Container-relative path to the workspace (e.g. /spaces/main). */
  containerWorkspace: string;
}

export interface BeforeContainerEvent {
  /** The space the message belongs to. */
  spaceId: string;
  /** The user's prompt. */
  prompt: string;
  /** Platform-specific caller identifier. */
  callerId: string;
  /** Absolute path to the space workspace. */
  workspace: string;
  /** Container-relative path to the workspace (e.g. /spaces/main). */
  containerWorkspace: string;
}

export interface AfterContainerEvent {
  /** The space the message belongs to. */
  spaceId: string;
  /** The original user prompt. */
  prompt: string;
  /** The agent's reply (empty string on error). */
  reply: string;
  /** How long the container ran, in milliseconds. */
  durationMs: number;
  /** Present if the container failed. */
  error?: ContainerError;
}

// ---------------------------------------------------------------------------
// Event return types — mutations hooks can apply
// ---------------------------------------------------------------------------

/**
 * Return value from a `before_container` handler.
 * All fields are optional — return only what you want to mutate.
 */
export interface BeforeContainerResult {
  /** Extra text appended to the system prompt inside the container. */
  systemPrompt?: string;
  /** Extra environment variables passed to the container. */
  env?: Record<string, string>;
  /** If set, blocks the container from running entirely. */
  block?: { reason: string };
}

/**
 * Return value from an `after_container` handler.
 * All fields are optional — return only what you want to mutate.
 */
export interface AfterContainerResult {
  /** Replace the agent's reply. */
  reply?: string;
  /** If true, suppress the reply (don't send it to the chat). */
  suppress?: boolean;
}

/** Maps event names to their allowed return types. */
export type EventResult<E extends keyof MercuryEvents> =
  E extends "before_container"
    ? BeforeContainerResult | undefined
    : E extends "after_container"
      ? AfterContainerResult | undefined
      : undefined;

/** A typed event handler for a specific event. */
export type EventHandler<E extends keyof MercuryEvents> = (
  event: MercuryEvents[E],
  ctx: MercuryExtensionContext,
) => Promise<EventResult<E>>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Definition for a background job registered by an extension. */
export interface JobDef {
  /** Run on a fixed interval (milliseconds). Mutually exclusive with `cron`. */
  interval?: number;
  /** Run on a cron schedule (5-field expression). Mutually exclusive with `interval`. */
  cron?: string;
  /** The function to execute on each tick. */
  run: (ctx: MercuryExtensionContext) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Definition for a per-space config key registered by an extension. */
export interface ConfigDef {
  /** Human-readable description shown in `mrctl config get`. */
  description: string;
  /** Default value when not explicitly set. */
  default: string;
  /** Optional validator — return true if value is acceptable. */
  validate?: (value: string) => boolean;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Definition for a dashboard widget registered by an extension. */
export interface WidgetDef {
  /** Display label shown in the dashboard. */
  label: string;
  /** Render function returning an HTML fragment. */
  render: (ctx: MercuryExtensionContext) => string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Scoped key-value store for extension-private persistent state. */
export interface ExtensionStore {
  /** Get a value by key, or null if not set. */
  get(key: string): string | null;
  /** Set a key-value pair (upsert). */
  set(key: string, value: string): void;
  /** Delete a key. Returns true if the key existed. */
  delete(key: string): boolean;
  /** List all key-value pairs for this extension. */
  list(): Array<{ key: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Extension API — the object passed to each extension's setup function
// ---------------------------------------------------------------------------

/** The API surface available to extensions during setup. */
export interface MercuryExtensionAPI {
  /** The extension's name (directory name). */
  readonly name: string;

  /**
   * Declare a CLI tool to install in the derived container image.
   * Can only be called once per extension.
   *
   * @example
   * mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
   */
  cli(opts: CliDef): void;

  /**
   * Register this extension's permission and set which roles get it by default.
   * The permission name is the extension name. Can only be called once.
   *
   * @example
   * mercury.permission({ defaultRoles: ["admin", "member"] });
   */
  permission(opts: PermissionDef): void;

  /**
   * Register a skill directory containing a SKILL.md for agent discovery.
   * Path is relative to the extension directory.
   *
   * @example
   * mercury.skill("./skill");
   */
  skill(relativePath: string): void;

  /**
   * Subscribe to a lifecycle event.
   *
   * @example
   * mercury.on("workspace_init", async (event, ctx) => {
   *   mkdirSync(join(event.workspace, "my-dir"), { recursive: true });
   * });
   */
  on<E extends keyof MercuryEvents>(event: E, handler: EventHandler<E>): void;

  /**
   * Register a background job that runs on the host.
   *
   * @example
   * mercury.job("cleanup", { interval: 3600_000, run: async (ctx) => { ... } });
   */
  job(name: string, def: JobDef): void;

  /**
   * Register a per-space config key. Namespaced to the extension automatically.
   *
   * @example
   * mercury.config("enabled", { description: "Enable for this group", default: "true" });
   * // Registers as "napkin.enabled" in the DB
   */
  config(key: string, def: ConfigDef): void;

  /**
   * Register a dashboard widget.
   *
   * @example
   * mercury.widget({ label: "Status", render: (ctx) => "<p>OK</p>" });
   */
  widget(def: WidgetDef): void;

  /** Scoped key-value store for persistent extension state. */
  readonly store: ExtensionStore;
}

// ---------------------------------------------------------------------------
// CLI + Permission definitions
// ---------------------------------------------------------------------------

/** Declaration for a CLI tool to install in the container image. */
export interface CliDef {
  /** CLI binary name (should match the extension name). */
  name: string;
  /** Shell command to install the CLI (runs as a Dockerfile RUN step). */
  install: string;
}

/** Permission configuration for an extension. */
export interface PermissionDef {
  /** Roles that should have this permission by default. */
  defaultRoles: string[];
}

// ---------------------------------------------------------------------------
// Extension metadata — collected after running the setup function
// ---------------------------------------------------------------------------

/** Fully resolved metadata for a loaded extension. */
export interface ExtensionMeta {
  /** Extension name (directory name). */
  name: string;
  /** Absolute path to the extension directory. */
  dir: string;
  /** CLI declaration, if any. */
  cli?: CliDef;
  /** Permission configuration, if any. */
  permission?: PermissionDef;
  /** Absolute path to the skill directory, if declared. */
  skillDir?: string;
  /** Event handlers keyed by event name. */
  hooks: Map<keyof MercuryEvents, EventHandler<keyof MercuryEvents>[]>;
  /** Background jobs keyed by job name. */
  jobs: Map<string, JobDef>;
  /** Config key definitions keyed by local key (not namespaced). */
  configs: Map<string, ConfigDef>;
  /** Dashboard widgets. */
  widgets: WidgetDef[];
}

// ---------------------------------------------------------------------------
// Extension setup function signature
// ---------------------------------------------------------------------------

/** The default export every extension must provide. */
export type ExtensionSetupFn = (api: MercuryExtensionAPI) => void;
