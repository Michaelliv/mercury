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

Authenticate:

```bash
mercury auth login              # Interactive OAuth (Anthropic, GitHub Copilot, etc.)
mercury auth login anthropic    # Or specify provider directly
mercury auth status             # Check what's configured
```

Or set an API key in `.env`:

```bash
MERCURY_ANTHROPIC_API_KEY=sk-ant-...
```

Configure identity and adapters in `.env`:

```bash
MERCURY_BOT_USERNAME=Mercury
MERCURY_TRIGGER_PATTERNS=@Mercury,Mercury

# Enable adapters
MERCURY_ENABLE_WHATSAPP=true
MERCURY_ENABLE_DISCORD=true
MERCURY_DISCORD_BOT_TOKEN=your-bot-token
```

Start:

```bash
mercury run
# or install as a background service:
mercury service install
```

### Set up spaces and conversations

Mercury discovers conversations from incoming traffic. They start **unlinked** — you assign them to **spaces** (memory boundaries).

```bash
# Create spaces
mercury spaces create main
mercury spaces create work
mercury spaces create family

# Send a message from WhatsApp/Discord/Slack, then:
mercury conversations              # See discovered conversations
mercury conversations --unlinked   # See unlinked ones
mercury link <id> main             # Link a conversation to a space
```

Multiple conversations can point at the same space — they share memory, session, and vault.

---

## How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                        Host Process                          │
│                                                              │
│   ┌──────────┐  ┌─────────┐  ┌─────────┐  ┌───────────────┐  │
│   │ WhatsApp │  │  Slack  │  │ Discord │  │   Scheduler   │  │
│   │ Adapter  │  │ Adapter │  │ Adapter │  │ (cron tasks)  │  │
│   └───┬──────┘  └────┬────┘  └───┬─────┘  └──────┬────────┘  │
│       └──────────────┴───────────┴───────────────┘           │
│                              │                               │
│                     ┌────────▼────────┐                      │
│                     │  Router/Queue   │                      │
│                     └────────┬────────┘                      │
│                              │                               │
│                     ┌────────▼────────┐                      │
│                     │    SQLite DB    │                      │
│                     └────────┬────────┘                      │
└──────────────────────────────┼───────────────────────────────┘
                               │
                     ┌─────────▼──────────┐
                     │  Docker Container  │
                     │  ┌──────────────┐  │
                     │  │    pi CLI    │  │
                     │  └──────────────┘  │
                     │ /spaces/<space-id> │
                     └────────────────────┘
```

Each space is a user-defined memory boundary with its own workspace and pi session. Incoming platform conversations are discovered automatically, then linked into spaces.

---

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Multi-platform** | WhatsApp, Slack, Discord | [docs/pipeline.md](docs/pipeline.md) |
| **Memory** | Obsidian-compatible vault per space | [docs/memory.md](docs/memory.md) |
| **Scheduled Tasks** | Cron-based recurring prompts | [docs/scheduler.md](docs/scheduler.md) |
| **Permissions** | Role-based access control | [docs/permissions.md](docs/permissions.md) |
| **Media** | Images, documents, voice notes | [docs/media/overview.md](docs/media/overview.md) |
| **KB Distillation** | Extract lasting knowledge from chats | [docs/kb-distillation.md](docs/kb-distillation.md) |
| **Extensions** | TypeScript plugins for CLIs, skills, jobs, hooks | [docs/extensions.md](docs/extensions.md) |

---

## Workspaces

Each space gets an Obsidian-compatible workspace:

```
.mercury/spaces/<space-id>/
├── AGENTS.md              # Space instructions
├── .mercury.session.jsonl # pi session
├── .obsidian/             # Vault marker
├── entities/              # Memory pages
├── daily/                 # Daily notes
├── inbox/                 # Media received from users
└── outbox/                # Files produced by the agent
```

The agent can read/write files. You can open it in Obsidian. Multiple platform conversations can point at the same space.

---

## CLI

### `mercury` (host CLI)

```bash
# setup + runtime
mercury init
mercury run
mercury build
mercury status

# auth
mercury auth login [provider]
mercury auth logout [provider]
mercury auth status
mercury auth whatsapp

# chat + routing
mercury chat "hello"
mercury chat --file photo.jpg "what's in this?"
mercury chat --space work "check status"
echo "summarize" | mercury chat
mercury spaces list
mercury spaces create <id>
mercury conversations
mercury conversations --unlinked
mercury link <conversation-id> <space-id>

# extensions
mercury add ./path/to/extension
mercury add npm:<package>
mercury add git:<repo-url>
mercury remove <name>
mercury extensions list

# service (recommended for background)
mercury service install
mercury service uninstall
mercury service status
mercury service logs [-f]
```

### `mrctl` (in-container API CLI)

```bash
mrctl whoami
mrctl tasks list|create|pause|resume|run|delete
mrctl roles list|grant|revoke
mrctl permissions show|set
mrctl config get|set
mrctl spaces list|name|delete
mrctl conversations list
mrctl stop
mrctl compact
```

For full command docs, run `mercury --help`, `mercury <command> --help`, or `mrctl help`.

---

## Extensions

Mercury supports TypeScript extensions that add CLIs, skills, background jobs, lifecycle hooks, config keys, and dashboard widgets.

```
.mercury/extensions/
├── napkin/
│   ├── index.ts
│   └── skill/SKILL.md
└── my-extension/
    └── index.ts
```

Each extension exports a setup function:

```typescript
export default function(mercury) {
  mercury.cli({ name: "napkin", install: "bun add -g napkin-ai" });
  mercury.permission({ defaultRoles: ["admin", "member"] });
  mercury.skill("./skill");
  mercury.on("workspace_init", async ({ workspace, containerWorkspace }) => { ... });
  mercury.on("before_container", async ({ workspace, containerWorkspace }) => {
    return { env: { MY_VAR: containerWorkspace + "/data" } };
  });
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
| `MERCURY_PORT` | `8787` | API port |
| `MERCURY_BOT_USERNAME` | `mercury` | Bot display name |
| `MERCURY_LOG_LEVEL` | `info` | Log level |

**Auth:**

Credentials are resolved in this order:
1. OAuth credentials from `mercury auth login` (saved to `.mercury/global/auth.json`)
2. API keys from `.env` (e.g., `MERCURY_ANTHROPIC_API_KEY`)

Supported OAuth providers: Anthropic, GitHub Copilot, Google Gemini CLI, Antigravity, OpenAI Codex.

**Model:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MERCURY_MODEL_PROVIDER` | `anthropic` | Provider |
| `MERCURY_MODEL` | `claude-opus-4-6` | Model |
| `MERCURY_ANTHROPIC_API_KEY` | — | API key |
| `MERCURY_ANTHROPIC_OAUTH_TOKEN` | — | OAuth token (alternative) |

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

### Per-space Config

Conversations are discovered from incoming traffic. Unlinked conversations stay idle until you attach them to a space via `mercury link <conversation-id> <space-id>` or the dashboard.

```bash
mrctl config set trigger_match always
mrctl config set trigger_patterns "@Bot,Bot"
```

---

## Docs

- [Authentication](docs/auth/overview.md)
- [Message pipeline](docs/pipeline.md)
- [Memory system](docs/memory.md)
- [Scheduled tasks](docs/scheduler.md)
- [Permissions](docs/permissions.md)
- [Media handling](docs/media/overview.md)
- [KB distillation](docs/kb-distillation.md)
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
