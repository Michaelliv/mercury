# Mercury — Agent Instructions

Personal AI assistant for chat platforms. Runs agents in Docker containers using [pi](https://github.com/badlogic/pi) as the runtime.

## Commands

```bash
bun run check        # Typecheck + lint + test (run before PR)
bun run check:fix    # Same but auto-fix lint issues
bun test             # Tests only
bun run typecheck    # TypeScript only
bun run lint         # Biome only
```

## Running in Background

The preferred way to run Mercury in the background is via system service (not tmux):

```bash
mercury service install   # Install as launchd (macOS) or systemd (Linux)
mercury service status    # Check if running
mercury service logs -f   # Tail logs
mercury service uninstall # Remove service
```

This provides auto-restart on crash and proper system integration. See [deployment.md](docs/deployment.md) for details.

## Structure

```
src/
├── main.ts                 # Entry point — bootstraps everything
├── server.ts               # Hono HTTP server factory
├── config.ts               # Zod schema + env parsing
├── logger.ts               # Pino logger
├── types.ts                # Shared types
│
├── adapters/               # Platform adapters
│   ├── setup.ts                # Adapter initialization
│   ├── whatsapp.ts             # Baileys-based WhatsApp
│   ├── whatsapp-media.ts       # Media download/upload
│   ├── slack.ts                # Slack Events API
│   ├── discord.ts              # Discord interactions
│   └── discord-native.ts       # Discord gateway
│
├── bridges/                # Platform bridge implementations
│   ├── whatsapp.ts             # WhatsApp PlatformBridge
│   ├── discord.ts              # Discord PlatformBridge
│   └── slack.ts                # Slack PlatformBridge
│
├── core/
│   ├── runtime.ts              # Main orchestrator
│   ├── handler.ts              # Unified message handler
│   ├── router.ts               # Message routing
│   ├── group-queue.ts          # Per-group concurrency
│   ├── task-scheduler.ts       # Task scheduling (cron + at)
│   ├── permissions.ts          # RBAC
│   ├── trigger.ts              # Pattern matching
│   ├── media.ts                # Shared media utilities (MIME, URL download)
│   ├── outbox.ts               # Outbox directory scanner
│   ├── rate-limiter.ts         # Rate limiting
│   ├── api.ts                  # API app factory (Hono)
│   ├── api-types.ts            # Shared API types
│   └── routes/                 # API route handlers
│       ├── tasks.ts                # /api/tasks/*
│       ├── roles.ts                # /api/roles/* + /api/permissions/*
│       ├── config.ts               # /api/config/*
│       ├── groups.ts               # /api/groups/*
│       ├── control.ts              # /api/whoami, /api/stop, /api/compact
│       └── extensions.ts           # /api/ext/*
│
├── agent/
│   ├── container-runner.ts     # Spawns Docker containers
│   ├── container-entry.ts      # Runs inside container (calls pi)
│   └── container-error.ts      # Error types
│
├── storage/
│   ├── db.ts                   # SQLite schema + queries
│   ├── memory.ts               # Workspace management
│   └── pi-auth.ts              # Pi OAuth tokens
│
├── extensions/
│   ├── types.ts                # Extension system type definitions
│   ├── api.ts                  # MercuryExtensionAPI implementation
│   ├── loader.ts               # Extension discovery + ExtensionRegistry
│   ├── hooks.ts                # Hook dispatcher (lifecycle events)
│   ├── jobs.ts                 # Background job runner (interval + cron)
│   ├── config-registry.ts      # Extension config key registration
│   ├── skills.ts               # Skill installation (copy to global dir)
│   ├── image-builder.ts        # Derived Docker image builder
│   ├── reserved.ts             # Reserved extension names (shared constant)
│   ├── napkin/                 # Built-in: vault management (CLI + skill + hook)
│   │   ├── index.ts
│   │   └── skill/SKILL.md
│   └── kb-distill/             # Built-in: knowledge extraction (job + widget)
│       ├── index.ts
│       └── distill.ts
│
├── cli/
│   ├── mercury.ts              # Main CLI (init, run, build, add, remove, ext list)
│   ├── mrctl.ts                # In-container CLI
│   ├── kb-distill.ts           # Re-exports from extensions/kb-distill/
│   └── whatsapp-auth.ts        # WhatsApp QR auth
│
└── dashboard/
    └── index.html              # Admin dashboard (static)

tests/                      # Bun tests
docs/                       # Documentation
container/                  # Dockerfile + build.sh
resources/
├── templates/              # Init templates (AGENTS.md, .env)
├── prompts/                # KB distillation prompts
├── skills/                 # Built-in skills for mrctl commands
│   ├── tasks/SKILL.md
│   ├── roles/SKILL.md
│   ├── permissions/SKILL.md
│   ├── config/SKILL.md
│   └── groups/SKILL.md
└── extensions/             # Pi extensions (subagent)
```

## Key Files

| File | What it does |
|------|--------------|
| `main.ts` | Entry point — initializes runtime, adapters, server |
| `server.ts` | Creates Hono app with all routes (dashboard, API, webhooks) |
| `runtime.ts` | Orchestrates message → container → reply flow |
| `db.ts` | All SQLite: groups, messages, tasks, roles, config |
| `container-runner.ts` | Docker spawn, timeout, cleanup |
| `config.ts` | Environment parsing with Zod |
| `core/api.ts` | Creates API app, mounts route handlers |
| `core/routes/*.ts` | Individual API route handlers |
| `extensions/loader.ts` | Extension discovery, loading via Bun import, registry |
| `extensions/hooks.ts` | Hook dispatch with mutation semantics for before/after_container |
| `extensions/jobs.ts` | Background job runner — interval and cron scheduling |
| `extensions/config-registry.ts` | Extension config key registration with validation |
| `extensions/skills.ts` | Copy extension skills to global dir (not symlink — Docker mount) |
| `extensions/image-builder.ts` | Derived Docker image with extension CLIs, content-hash cache |
| `extensions/napkin/index.ts` | Built-in extension: vault dirs, CLI, skill, workspace_init hook |
| `extensions/kb-distill/index.ts` | Built-in extension: distillation job, config, dashboard widget |

## Database Schema

Tables in `state.db`:
- `groups` — Chat groups/channels
- `messages` — Message history (for ambient context)
- `tasks` — Scheduled tasks (cron + one-shot at)
- `group_roles` — User role assignments per group
- `group_config` — Per-group config overrides + role permission sets
- `extension_state` — Scoped key-value store for extensions `(extension, key) → value`

## API

Internal API used by `mrctl` from inside containers:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/whoami` | GET | Caller + group info |
| `/api/tasks` | GET/POST | List/create tasks |
| `/api/tasks/:id` | DELETE | Delete task |
| `/api/tasks/:id/pause` | POST | Pause task |
| `/api/tasks/:id/resume` | POST | Resume task |
| `/api/roles` | GET/POST/DELETE | Role management |
| `/api/permissions` | GET/POST | Permission management |
| `/api/config` | GET/POST | Group config |
| `/api/stop` | POST | Abort current run |
| `/api/compact` | POST | Session boundary |
| `/api/ext` | GET | List installed extensions |
| `/api/ext/:name/auth` | POST | Permission check for extension CLI |

Auth: `X-Mercury-Caller` + `X-Mercury-Group` headers.

## Extension System

Mercury has a TypeScript extension system. Extensions live in `.mercury/extensions/*/` and export a setup function:

```typescript
import type { MercuryExtensionAPI } from "../extensions/types.js";

export default function(mercury: MercuryExtensionAPI) {
  mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");
  mercury.on("workspace_init", async (event, ctx) => { ... });
  mercury.job("distill", { interval: 3600_000, run: async (ctx) => { ... } });
  mercury.config("enabled", { description: "...", default: "true" });
  mercury.widget({ label: "Status", render: (ctx) => "<p>OK</p>" });
  mercury.store.get("key");
}
```

Key types are in `src/extensions/types.ts`. See [docs/extensions.md](docs/extensions.md) for the full design.

### Built-in vs extension commands

`mrctl` has two types of commands:
- **Built-in**: `tasks`, `roles`, `permissions`, `config`, `groups`, `stop`, `compact` — HTTP calls to host API
- **Extension**: `mrctl <ext-name> <args>` — permission check then local CLI exec in container

Built-in names are reserved — extensions cannot collide with them.

### Permissions

Permissions are now dynamic. Built-in permissions are static; extensions register new ones at runtime via `registerPermission()`. Admin always gets all permissions. See `src/core/permissions.ts`.

## Docs

| Doc | Topic |
|-----|-------|
| [pipeline.md](docs/pipeline.md) | Message pipeline (ingress/egress) |
| [memory.md](docs/memory.md) | Obsidian vault system |
| [scheduler.md](docs/scheduler.md) | Task scheduling (cron + at) |
| [permissions.md](docs/permissions.md) | RBAC system |
| [kb-distillation.md](docs/kb-distillation.md) | Knowledge extraction |
| [container-lifecycle.md](docs/container-lifecycle.md) | Docker management |
| [graceful-shutdown.md](docs/graceful-shutdown.md) | Shutdown sequence |
| [rate-limiting.md](docs/rate-limiting.md) | Rate limits |
| [media/overview.md](docs/media/overview.md) | Media handling |
| [extensions.md](docs/extensions.md) | Extension system design |

## Conventions

- **Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- **Branches**: `issue-<num>-<slug>` for GitHub issues
- **Tests**: Co-located in `tests/`, use temp DBs
- **Config**: All via env vars, parsed in `config.ts`
- **Errors**: Use typed errors from `container-error.ts`
