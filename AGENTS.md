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

## Structure

```
src/
├── adapters/           # Platform adapters
│   ├── whatsapp.ts         # Baileys-based WhatsApp
│   ├── whatsapp-media.ts   # Media download/upload
│   ├── slack.ts            # Slack Events API
│   └── discord.ts          # Discord interactions
├── agent/
│   ├── container-runner.ts # Spawns Docker containers
│   ├── container-entry.ts  # Runs inside container (calls pi)
│   └── container-error.ts  # Error types
├── core/
│   ├── runtime.ts          # Main orchestrator
│   ├── router.ts           # Message routing
│   ├── group-queue.ts      # Per-group concurrency
│   ├── task-scheduler.ts   # Task scheduling (cron + at)
│   ├── permissions.ts      # RBAC
│   ├── trigger.ts          # Pattern matching
│   ├── rate-limiter.ts     # Rate limiting
│   └── api.ts              # Internal API (/api/*)
├── storage/
│   ├── db.ts               # SQLite schema + queries
│   ├── memory.ts           # Workspace management
│   └── pi-auth.ts          # Pi OAuth tokens
├── cli/
│   ├── mercury.ts          # Main CLI (init, run, build)
│   ├── mercury-ctl.ts      # In-container CLI
│   ├── kb-distill.ts       # KB distillation logic
│   └── whatsapp-auth.ts    # WhatsApp QR auth
├── dashboard/
│   └── index.html          # Admin dashboard (static)
├── chat-sdk.ts             # Entry point, HTTP server
├── config.ts               # Zod schema + env parsing
├── logger.ts               # Pino logger
└── types.ts                # Shared types

tests/                  # Bun tests
docs/                   # Documentation
container/              # Dockerfile + build.sh
resources/
├── templates/          # Init templates (AGENTS.md, .env)
├── prompts/            # KB distillation prompts
└── extensions/         # Pi extensions (subagent)
```

## Key Files

| File | What it does |
|------|--------------|
| `chat-sdk.ts` | Entry point — starts server, adapters, scheduler |
| `runtime.ts` | Orchestrates message → container → reply flow |
| `db.ts` | All SQLite: groups, messages, tasks, roles, config |
| `container-runner.ts` | Docker spawn, timeout, cleanup |
| `config.ts` | Environment parsing with Zod |

## Database Schema

Tables in `state.db`:
- `groups` — Chat groups/channels
- `messages` — Message history (for ambient context)
- `tasks` — Scheduled tasks (cron + one-shot at)
- `roles` — User role assignments
- `permissions` — Role permission sets
- `config` — Per-group config overrides

## API

Internal API used by `mercury-ctl` from inside containers:

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

Auth: `X-Mercury-Caller` + `X-Mercury-Group` headers.

## Docs

| Doc | Topic |
|-----|-------|
| [ingress.md](docs/ingress.md) | Adapter message flow |
| [memory.md](docs/memory.md) | Obsidian vault system |
| [scheduler.md](docs/scheduler.md) | Task scheduling (cron + at) |
| [permissions.md](docs/permissions.md) | RBAC system |
| [kb-distillation.md](docs/kb-distillation.md) | Knowledge extraction |
| [container-lifecycle.md](docs/container-lifecycle.md) | Docker management |
| [graceful-shutdown.md](docs/graceful-shutdown.md) | Shutdown sequence |
| [rate-limiting.md](docs/rate-limiting.md) | Rate limits |
| [media/overview.md](docs/media/overview.md) | Media handling |

## Conventions

- **Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- **Branches**: `issue-<num>-<slug>` for GitHub issues
- **Tests**: Co-located in `tests/`, use temp DBs
- **Config**: All via env vars, parsed in `config.ts`
- **Errors**: Use typed errors from `container-error.ts`
