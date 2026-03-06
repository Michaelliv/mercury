# Media Handling

Mercury downloads and processes media attachments from chat platforms, saving them to group workspaces and passing them to pi for processing. Models can also produce files via the `outbox/` directory.

## Supported Platforms

| Platform | Ingress | Egress | Details |
|----------|---------|--------|---------|
| WhatsApp | ✅ Baileys socket | ✅ image/video/audio/document | [whatsapp.md](./whatsapp.md) |
| Discord | ✅ CDN URL download | ✅ channel.send() with files | Via `DiscordBridge` |
| Slack | ✅ URL download (auth'd) | ✅ files.uploadV2 | Via `SlackBridge` |

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────┐
│   Platform   │────▶│   Bridge     │────▶│   Runtime    │────▶│   pi    │
│              │     │ (normalize)  │     │ (store/pass) │     │ (view)  │
└──────────────┘     └──────────────┘     └──────────────┘     └─────────┘
                            │                    │
                            ▼                    ▼
                     ┌──────────────┐     ┌──────────────┐
                     │  Workspace   │     │  Workspace   │
                     │   /inbox/    │     │   /outbox/   │
                     └──────────────┘     └──────────────┘
```

## Media Types

All platforms map to these generic types defined in `src/types.ts`:

```typescript
type MediaType = "image" | "video" | "audio" | "voice" | "document";

interface MessageAttachment {
  path: string;        // Local file path
  type: MediaType;     // Generic type
  mimeType: string;    // MIME type (e.g., "image/jpeg")
  filename?: string;   // Original filename if available
  sizeBytes?: number;  // File size in bytes
}
```

## Configuration

| Env Variable | Default | Description |
|--------------|---------|-------------|
| `MERCURY_MEDIA_ENABLED` | `true` | Enable/disable media downloads |
| `MERCURY_MEDIA_MAX_SIZE_MB` | `10` | Max file size to download (MB) |

## Storage

### Ingress (inbox/)

Incoming media files are saved to the group workspace:

```
.mercury/groups/<group_id>/inbox/<timestamp>-<type>.<ext>
```

Example:
```
.mercury/groups/whatsapp_123456_g_us/inbox/
├── 1709012345-image.jpg
├── 1709012400-voice.ogg
└── 1709012500-document.pdf
```

### Egress (outbox/)

The model writes files to `outbox/` during a container run. After exit, the runtime scans for files with `mtime >= startTime` and attaches them to the reply:

```
.mercury/groups/<group_id>/outbox/
├── chart.png
└── summary.pdf
```

Previous outbox files are not deleted — only new or modified files are sent. See [pipeline.md](../pipeline.md) for details.

## Database Schema

Attachments are stored as JSON in the `messages.attachments` column:

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT;
```

```json
[
  {
    "path": "/Users/.../media/1709012345-image.jpg",
    "type": "image",
    "mimeType": "image/jpeg",
    "sizeBytes": 12345
  }
]
```

## Prompt Format

Attachments are passed to pi as XML:

```xml
<attachments>
  <attachment type="image" path="/groups/xxx/media/123-image.jpg" mime="image/jpeg" size="12345" />
</attachments>

@mercury what's in this image?
```

Reply context includes media info:

```xml
<reply_to name="John" jid="123@wa" message_id="ABC" media_type="image" media_mime="image/jpeg">
Check out this sunset!
</reply_to>
```

## pi Capabilities

| Media Type | pi Support |
|------------|------------|
| Images (jpg, png, gif, webp) | ✅ Can view via `read` tool |
| Voice/Audio | ❌ Cannot play — needs transcription |
| Video | ❌ Cannot play — could extract frames |
| Documents (txt, code) | ✅ Can read text-based files |
| Documents (pdf, docx) | ❌ Cannot read binary formats |

## Future Enhancements

- [ ] Voice transcription via OpenAI Whisper
- [ ] Video frame extraction
- [ ] PDF text extraction
