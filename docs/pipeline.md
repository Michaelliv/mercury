# Message Pipeline

Mercury connects to chat platforms through **adapters** and **bridges**. Messages flow through a standardized pipeline regardless of platform:

```
Platform → Adapter → PlatformBridge.normalize() → handleRawInput() → Container → PlatformBridge.sendReply()
```

## Architecture

```
Platform (WhatsApp / Slack / Discord)
  │
  ├─► Adapter receives raw message
  │     • Platform-specific connection (socket, webhook)
  │     • Mention normalization, reply-to-bot detection
  │     • Media download (WhatsApp only — uses Baileys socket)
  │     • Passes data via message metadata
  │
  ├─► Unified handler (src/core/handler.ts)
  │     • Pre-route trigger check (cheap, sync)
  │     • Start typing indicator if matched
  │     • Call bridge.normalize() → IngressMessage
  │     • Start typing for reply-to-bot (detected during normalize)
  │
  ├─► core.handleRawInput(IngressMessage)
  │     • Route: trigger match, permissions, command detection
  │     • If triggered → queue → container run → ContainerResult
  │     • If not triggered → store as ambient context
  │     • If command → execute immediately (stop, compact)
  │     • If denied → return reason
  │
  └─► bridge.sendReply(text, files?)
        • Text reply via adapter
        • File attachments via platform-specific API
```

## PlatformBridge

Each platform implements a single `PlatformBridge` interface covering both ingress and egress:

```typescript
interface PlatformBridge {
  readonly platform: string;
  groupId(threadId: string): string;     // Thread → group mapping
  isDM(threadId: string): boolean;       // DM detection
  normalize(threadId, message, ctx): Promise<IngressMessage | null>;
  sendReply(threadId, text, files?): Promise<void>;
}
```

Bridges live in `src/bridges/`:

| Bridge | File | Platform details |
|--------|------|-----------------|
| `WhatsAppBridge` | `src/bridges/whatsapp.ts` | Baileys socket for file sending |
| `DiscordBridge` | `src/bridges/discord.ts` | discord.js channel.send() for files |
| `SlackBridge` | `src/bridges/slack.ts` | Slack files.uploadV2 API |

## Ingress

### IngressMessage

Every adapter produces a normalized `IngressMessage`:

```typescript
interface IngressMessage {
  platform: string;
  groupId: string;
  callerId: string;        // "whatsapp:jid", "discord:123", "slack:U123"
  authorName?: string;
  text: string;
  isDM: boolean;
  isReplyToBot: boolean;
  attachments: MessageAttachment[];
}
```

All fields are required (no optional booleans) — adapters must make explicit decisions.

### inbox/ directory

Incoming media attachments are downloaded to `{workspace}/inbox/`:

```
{workspace}/
├── inbox/
│   ├── 1741243200000-photo.jpg
│   ├── 1741243500000-voice.ogg
│   └── 1741244000000-report.pdf
```

WhatsApp downloads via Baileys socket. Discord and Slack use URL-based download (`src/core/media.ts`) with optional auth headers.

## Egress

### ContainerResult

Container runs return `ContainerResult` instead of a plain string:

```typescript
interface ContainerResult {
  reply: string;
  files: EgressFile[];  // Scanned from workspace outbox/
}
```

### outbox/ directory

The model writes files to `./outbox/` during a run. After the container exits, the runtime scans for files with `mtime >= startTime` — new or modified files are attached to the reply.

```
{workspace}/
├── outbox/
│   ├── chart.png       ← written by model, sent with reply
│   └── summary.pdf     ← written by model, sent with reply
```

Previous outbox files are NOT deleted — the agent retains history. Only files created or modified during the current run are sent.

### File sending by platform

| Platform | Mechanism |
|----------|-----------|
| WhatsApp | `sock.sendMessage()` with image/video/audio/document content types, caption on last file |
| Discord | `channel.send({ files: [...] })` — text + files in one message |
| Slack | `files.uploadV2` API — text sent first, then files uploaded separately |

## Adapters

### WhatsApp

Uses [Baileys](https://github.com/WhiskeySockets/Baileys) for a direct WebSocket connection.

| Detail | Value |
|--------|-------|
| **Connection** | WebSocket (Baileys) |
| **Group ID** | Full thread ID (e.g., `whatsapp:12345@g.us:12345@g.us`) |
| **DM detection** | Thread ID does not contain `@g.us` |
| **@mention** | Bot JID mention replaced with configured `userName` in adapter |
| **Reply-to-bot** | Quoted message participant matches bot JID |
| **Media** | Downloaded via Baileys to `inbox/` |

### Discord

Uses discord.js with persistent WebSocket gateway.

| Detail | Value |
|--------|-------|
| **Connection** | WebSocket (discord.js) |
| **Group ID** | Full thread ID (e.g., `discord:guild:channel[:thread]`) |
| **DM detection** | Guild ID is `@me` |
| **@mention** | `<@botId>` converted to `@userName` in bridge |
| **Reply-to-bot** | Replied-to message author matches bot ID |
| **Media** | Downloaded from CDN URLs to `inbox/` |

### Slack

Uses `@chat-adapter/slack` with webhook-based event delivery.

| Detail | Value |
|--------|-------|
| **Connection** | Webhook (`POST /webhooks/slack`) |
| **Group ID** | `slack:<channelId>` (channel-level, threads share a group) |
| **DM detection** | Channel starts with `D` or `G` |
| **Reply-to-bot** | Not implemented (Slack threading model) |
| **Media** | Downloaded from `url_private` with bot token auth to `inbox/` |

## Trigger Matching

All platforms share the same trigger engine. A pre-route check runs before `normalize()` so the typing indicator fires early.

| Mode | Behavior |
|------|----------|
| `mention` | Message contains trigger pattern as a standalone word (default) |
| `prefix` | Message starts with trigger pattern |
| `always` | Every message triggers a response |

DMs always match regardless of mode.

### Reply-to-Bot

Replying to a bot message triggers a response without explicit `@mention`. Works on WhatsApp and Discord. Not implemented for Slack.

## Adding a New Platform

1. Implement `PlatformBridge` in `src/bridges/<platform>.ts`
2. Create adapter in `src/adapters/<platform>.ts` (or use existing chat-sdk adapter)
3. Register bridge in `src/main.ts`
4. Add tests in `tests/<platform>-bridge.test.ts`
