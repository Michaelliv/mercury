<p align="center">
  <img src="assets/logo-with-text.svg" alt="Mercury" height="120" />
</p>

<p align="center">
  <em>There are many claws, but this one is mine.</em>
</p>

<p align="center">
  <a href="https://github.com/Michaelliv/mercury"><img alt="GitHub" src="https://img.shields.io/badge/github-mercury-181717?style=flat-square&logo=github" /></a>
  <a href="https://www.npmjs.com/package/mercury-ai"><img alt="npm" src="https://img.shields.io/npm/v/mercury-ai?style=flat-square&logo=npm" /></a>
</p>

Mercury is a personal AI assistant that lives where you chat. It connects to WhatsApp, Slack, and Discord, runs agents inside containers for isolation, and uses [pi](https://github.com/badlogic/pi) as the runtime.

---

## Quick Start

```bash
npm install -g mercury-ai
mkdir my-assistant && cd my-assistant
mercury init
```

Edit `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...

# Enable adapters
MERCURY_ENABLE_WHATSAPP=true
MERCURY_ENABLE_DISCORD=true
DISCORD_BOT_TOKEN=your-bot-token
```

Run:

```bash
mercury run
```

Scan the QR code with WhatsApp. You're live.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         Host Process                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │ WhatsApp │  │  Slack   │  │ Discord  │  │    Scheduler     │ │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │  (cron tasks)    │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
│       └─────────────┴─────────────┴─────────────────┘           │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │  Router/Queue   │                          │
│                    └────────┬────────┘                          │
│                             │                                   │
│                    ┌────────▼────────┐                          │
│                    │   SQLite DB     │                          │
│                    └────────┬────────┘                          │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Docker Container │
                    │  ┌─────────────┐  │
                    │  │   pi CLI    │  │
                    │  └─────────────┘  │
                    │  /groups/<id>     │
                    └───────────────────┘
```

Each chat group gets its own workspace and pi session. Messages are routed, queued, and executed in isolated containers.

---

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Multi-platform** | WhatsApp, Slack, Discord | [docs/pipeline.md](docs/pipeline.md) |
| **Memory** | Obsidian-compatible vault per group | [docs/memory.md](docs/memory.md) |
| **Scheduled Tasks** | Cron-based recurring prompts | [docs/scheduler.md](docs/scheduler.md) |
| **Permissions** | Role-based access control | [docs/permissions.md](docs/permissions.md) |
| **Media** | Images, documents, voice notes | [docs/media/overview.md](docs/media/overview.md) |
| **KB Distillation** | Extract lasting knowledge from chats | [docs/kb-distillation.md](docs/kb-distillation.md) |
| **Subagents** | Delegate tasks to specialized agents | [docs/subagents.md](docs/subagents.md) |
| **Extensions** | TypeScript plugins for CLIs, skills, jobs, hooks | [docs/extensions.md](docs/extensions.md) |

---

## Workspaces

Each group gets an Obsidian-compatible workspace:

```
.mercury/groups/<group-id>/
├── AGENTS.md              # Group instructions
├── .mercury.session.jsonl # pi session
├── .obsidian/             # Vault marker
├── entities/              # Memory pages
├── daily/                 # Daily notes
└── media/                 # Downloaded files
```

The agent can read/write files. You can open it in Obsidian.

---

## CLI

### mercury

```bash
mercury init      # Initialize project
mercury run       # Start the assistant
mercury build     # Rebuild container image
mercury status    # Show status
mercury kb-distill [--backfill]  # Run KB distillation

# Extension management
mercury add ./path/to/extension   # Install from local path
mercury add npm:<package>         # Install from npm
mercury add git:<repo-url>        # Install from git
mercury remove <name>             # Remove extension
mercury extensions list           # List installed extensions

# Service management (preferred for background running)
mercury service install    # Install as system service
mercury service uninstall  # Remove service
mercury service status     # Show service status
mercury service logs [-f]  # View/tail logs
```

### mrctl

Management CLI used by the agent inside containers:

```bash
mrctl whoami
mrctl tasks list|create|pause|resume|delete
mrctl roles list|grant|revoke
mrctl permissions show|set
mrctl config get|set
mrctl groups list|name|delete
mrctl stop
mrctl compact
mrctl ext list                # List installed extensions
mrctl <extension> [args...]   # Run extension CLI (permission-gated)
```



---

## Extensions

Mercury supports TypeScript extensions that add CLIs, skills, background jobs, lifecycle hooks, config keys, and dashboard widgets.

```
.mercury/extensions/
├── napkin/
│   ├── index.ts
│   └── skill/SKILL.md
└── kb-distill/
    └── index.ts
```

Each extension exports a setup function:

```typescript
export default function(mercury) {
  mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");
  mercury.on("workspace_init", async ({ workspace }) => { ... });
}
```

Extensions with CLIs get auto-installed into a derived Docker image. Skills are symlinked for agent discovery. Permissions integrate with the existing RBAC system.

See [docs/extensions.md](docs/extensions.md) for the full guide.

---

## Configuration

### Environment Variables

**Core:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_DATA_DIR` | `.mercury` | Data directory |
| `MERCURY_MAX_CONCURRENCY` | `3` | Max concurrent runs |
| `MERCURY_CHATSDK_PORT` | `3000` | API port |
| `MERCURY_LOG_LEVEL` | `info` | Log level |

**Model:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_MODEL_PROVIDER` | `anthropic` | Provider |
| `MERCURY_MODEL` | `claude-opus-4-6` | Model |
| `ANTHROPIC_API_KEY` | — | API key |
| `ANTHROPIC_OAUTH_TOKEN` | — | OAuth token (alternative to API key) |

**Adapters:**

| Variable | Description |
|----------|-------------|
| `MERCURY_ENABLE_WHATSAPP` | Enable WhatsApp |
| `MERCURY_WHATSAPP_AUTH_DIR` | Auth storage path |
| `MERCURY_ENABLE_DISCORD` | Enable Discord |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_SIGNING_SECRET` | Slack signing secret |

**Container:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_AGENT_CONTAINER_IMAGE` | `mercury-agent:latest` | Container image |
| `MERCURY_CONTAINER_TIMEOUT_MS` | `300000` | Container timeout (5 min) |

**KB Distillation:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_KB_DISTILL_INTERVAL_MS` | `0` (disabled) | Distillation interval |

**Triggers:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_TRIGGER_MATCH` | `mention` | `mention`, `prefix`, `always` |
| `MERCURY_TRIGGER_PATTERNS` | `@Mercury,Mercury` | Trigger patterns |
| `MERCURY_ADMINS` | — | Pre-seeded admin user IDs |

### Per-group Config

```bash
mrctl config set trigger_match always
mrctl config set trigger_patterns "@Bot,Bot"
```

---

## Docs

- [Message pipeline](docs/pipeline.md)
- [Memory system](docs/memory.md)
- [Scheduled tasks](docs/scheduler.md)
- [Permissions](docs/permissions.md)
- [Media handling](docs/media/overview.md)
- [KB distillation](docs/kb-distillation.md)
- [Subagents](docs/subagents.md)
- [Container lifecycle](docs/container-lifecycle.md)
- [Graceful shutdown](docs/graceful-shutdown.md)
- [Rate limiting](docs/rate-limiting.md)
- [Extensions](docs/extensions.md)

---

## License

MIT

---

<p align="center">
  <em>There are many claws, but this one is mine.</em> 🪽
</p>
