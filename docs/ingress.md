# Ingress

Mercury connects to chat platforms through **adapters**. Each adapter translates platform-specific messages into a common flow: trigger check → route → queue → container agent → reply.

## Message Flow

```
Platform (WhatsApp / Slack / Discord)
  │
  ├─► Adapter receives raw message
  │
  ├─► Platform-specific handler
  │     • Map thread → group ID
  │     • Detect DM vs group
  │     • Build caller ID
  │
  ├─► Pre-route trigger check
  │     • Load trigger config (global + per-group overrides)
  │     • If matched → start typing indicator (early UX)
  │
  ├─► core.handleRawInput()
  │     • Route: trigger match, permissions, command detection
  │     • If triggered → queue → container run → reply
  │     • If not triggered → store as ambient context
  │     • If command → execute immediately (stop, compact)
  │     • If denied → return reason
  │
  └─► Post reply to thread
```

## Adapters

### WhatsApp

Uses [Baileys](https://github.com/WhiskeySockets/Baileys) for a direct WhatsApp Web socket connection — no webhook needed.

| Detail | Value |
|--------|-------|
| **Connection** | WebSocket (Baileys) |
| **Auth** | QR code scan on first run, stored in auth dir |
| **Group ID** | `whatsapp:<chatJid>:<threadJid>` (full thread ID) |
| **Caller ID** | `whatsapp:<sender JID>` |
| **DM detection** | Thread ID does not end with `@g.us` |
| **@mention handling** | Bot's JID mention replaced with configured `userName` so trigger patterns match |
| **Outgoing queue** | Messages queued if socket disconnects, flushed on reconnect |
| **Reconnect** | Auto-reconnects after 3s on non-logout disconnects |
| **Media** | Images, videos, voice notes, documents downloaded to workspace |

```bash
MERCURY_ENABLE_WHATSAPP=true
MERCURY_WHATSAPP_AUTH_DIR=.mercury/whatsapp-auth  # optional
```

#### Media Support

WhatsApp media attachments are downloaded and saved to the group workspace. See [media/whatsapp.md](media/whatsapp.md) for details.

| Media Type | Source | Supported |
|------------|--------|-----------|
| Images | `imageMessage`, `stickerMessage` | ✅ |
| Videos | `videoMessage` | ✅ |
| Voice notes | `audioMessage` (ptt=true) | ✅ |
| Audio | `audioMessage` | ✅ |
| Documents | `documentMessage` | ✅ |

```bash
MERCURY_MEDIA_ENABLED=true          # default
MERCURY_MEDIA_MAX_SIZE_MB=10        # default
```

### Slack

Uses [`@chat-adapter/slack`](https://www.npmjs.com/package/@chat-adapter/slack) with webhook-based event delivery.

| Detail | Value |
|--------|-------|
| **Connection** | Webhook (`POST /webhooks/slack`) |
| **Auth** | Bot token + signing secret |
| **Group ID** | `slack:<channelId>` (channel-level, threads share a group) |
| **Caller ID** | `slack:<userId>` |
| **DM detection** | Channel starts with `D` (1:1 DM) or `G` (group DM / MPDM) |

```bash
MERCURY_ENABLE_SLACK=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

### Discord

Uses [`@chat-adapter/discord`](https://www.npmjs.com/package/@chat-adapter/discord) with webhook-based event delivery and an optional gateway trigger.

| Detail | Value |
|--------|-------|
| **Connection** | Webhook (`POST /webhooks/discord`) |
| **Auth** | Bot token + public key + application ID |
| **Group ID** | `discord:<channelId>` (channel-level, sub-threads share a group) |
| **Caller ID** | `discord:<userId>` |
| **DM detection** | Guild ID is `@me` |
| **Gateway** | Optional `GET /discord/gateway` endpoint, gated by `MERCURY_DISCORD_GATEWAY_SECRET` |

```bash
MERCURY_ENABLE_DISCORD=true
DISCORD_BOT_TOKEN=...
DISCORD_PUBLIC_KEY=...
DISCORD_APPLICATION_ID=...
```

## Group ID Mapping

Each platform maps threads to groups differently. The group ID determines workspace, session, permissions, and trigger config.

```
WhatsApp:  whatsapp:12345@g.us:12345@g.us     → used as-is (full thread ID)
Slack:     slack:C1234:1234567890.123456       → slack:C1234 (channel level)
Discord:   discord:111222:444555:777888        → discord:444555 (channel level)
```

Slack and Discord strip thread/sub-thread IDs so all conversations in a channel share one workspace and session. WhatsApp uses the full thread ID.

## Trigger Matching

All adapters share the same trigger engine. A pre-route check runs before `handleRawInput` so the typing indicator fires early.

| Mode | Behavior |
|------|----------|
| `mention` | Message contains trigger pattern as a standalone word (default) |
| `prefix` | Message starts with trigger pattern |
| `always` | Every message triggers a response |

DMs always match regardless of mode.

### Reply-to-Bot

Replying to a bot message triggers a response — no explicit `@mention` needed:

```
User: @Mercury what's the weather?
Bot: It's 72°F and sunny.
User: [replies] what about tomorrow?  ← triggers response
Bot: Tomorrow will be 75°F.
```

This works on WhatsApp (quoted messages) and Discord (reply threads). Slack uses a different threading model where users typically `@mention` in threads, so reply detection is not implemented there.

**Configuration:**

```bash
# Global defaults
MERCURY_TRIGGER_MATCH=mention
MERCURY_TRIGGER_PATTERNS=@Mercury,Mercury

# Per-group overrides (via mercury-ctl)
mercury-ctl config set trigger_match always
mercury-ctl config set trigger_patterns "@Bot,Bot"
mercury-ctl config set trigger_case_sensitive false
```

## Ambient Context

Non-triggered messages in group chats are stored as ambient context in the database. When the agent is next triggered, recent ambient messages are injected so it knows what was discussed between turns.

```
User A: anyone tried the new API?
User B: yeah it's broken
User A: @Mercury can you check the API logs?
         ↑ agent sees the prior conversation as context
```

## Adding a New Adapter

1. Create `src/adapters/<platform>.ts` with:
   - `<platform>GroupId(threadId)` — map thread → group ID
   - `is<Platform>DM(threadId)` — detect DMs
   - `<platform>CallerId(message)` — build caller ID
   - `create<Platform>MessageHandler({ core, db, config })` — message handler with pre-route trigger check

2. Wire into `src/chat-sdk.ts`:
   - Add adapter creation in the adapters block
   - Create platform-specific handler
   - Add `if (thread.adapter.name === "<platform>")` branch early in `handleMessage`

3. Add tests in `tests/<platform>-adapter.test.ts`

Follow the Slack adapter (`src/adapters/slack.ts`) as the reference implementation — it's the simplest.
