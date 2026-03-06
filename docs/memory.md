# Memory

Mercury uses an Obsidian-compatible vault for persistent memory. The agent reads and writes markdown files with wikilinks, giving it structured, human-readable memory that survives sessions.

## How It Works

Each group workspace is a valid Obsidian vault. The agent uses [napkin](https://github.com/michaelliv/napkin-ai) CLI to read, write, and query files.

```
.mercury/groups/<group-id>/
├── .obsidian/          # Makes it a valid Obsidian vault
├── entities/           # Entity pages (people, projects, things)
├── daily/              # Daily conversation logs
├── inbox/              # Media received from users
├── outbox/             # Files produced by the agent
├── AGENTS.md           # Persistent instructions (loaded by pi)
└── .pi/                # pi resources
```

## Vault Structure

| Directory | Purpose |
|-----------|---------|
| `.obsidian/` | Marker directory — makes the workspace Obsidian-compatible |
| `entities/` | Entity files (people, places, projects, concepts) |
| `daily/` | Daily notes for conversation logs |

The structure is created automatically by the napkin extension's `workspace_init` hook when a group workspace is initialized. See `src/extensions/napkin/index.ts`.

## Agent Capabilities

The agent discovers napkin commands via the napkin skill (`src/extensions/napkin/skill/SKILL.md`), which is loaded by pi on demand:

### Reading

```bash
napkin search "query"              # Find relevant files
napkin read "filename"             # Read a specific file
napkin link back --file "name"     # See what links to a file
napkin daily read                  # Read today's daily note
```

### Writing

```bash
napkin create --name "Liat" --path entities --content "..."
napkin append --file "Liat" --content "..."
napkin property set --file "Liat" --name birthday --value "April 15"
napkin daily append --content "- Discussed vacation plans"
```

### Wikilinks

The agent uses `[[wikilinks]]` when mentioning entities. This creates a navigable graph:

```markdown
---
type: person
relationship: wife
---

# Liat

[[Michael]]'s wife. Planning a surprise party at [[Dizengoff Italian Place]].
```

## User Interaction

Users manage memory through natural chat:

| User says | What happens |
|-----------|--------------|
| "Remember that Liat's birthday is April 15" | Agent writes to `entities/Liat.md` |
| "What do you know about Liat?" | Agent reads and summarizes the entity file |
| "Forget everything about the project" | Agent deletes the entity file |

## Entity Format

Entities are markdown files with optional YAML frontmatter:

```markdown
---
type: person
birthday: April 15
---

# Liat

Context and notes about Liat.

_2026-02-20:_ Booked the Italian place for April 12.
_2026-02-25:_ Changed venue to [[Cafe Nimrod]].
```

- **Frontmatter** — Structured attributes (replace semantics)
- **Body** — Accumulated context (append semantics, timestamped)
- **Wikilinks** — Connections to other entities

## Persistence

Memory persists because the agent writes to disk during conversation. When a session compacts or restarts, the vault files remain — the agent reads them fresh on next interaction.

The vault is plain markdown. You can:
- Open it in Obsidian and browse the graph
- Edit files directly from the host
- Back it up like any other directory

## Configuration

No additional configuration needed. The napkin extension is a built-in extension that loads automatically. The vault structure is created by the extension's `workspace_init` hook.

To use a shared Obsidian vault across tools, symlink or mount it:

```bash
ln -s /path/to/your/vault .mercury/groups/my-group
```
