# WhatsApp Media Handling

Downloads media from WhatsApp messages using the Baileys library.

## Supported Media Types

| WhatsApp Type | Detected As | Default MIME | Extensions |
|---------------|-------------|--------------|------------|
| `imageMessage` | `image` | `image/jpeg` | jpg, png, gif, webp |
| `videoMessage` | `video` | `video/mp4` | mp4, 3gp |
| `audioMessage` (ptt=true) | `voice` | `audio/ogg` | ogg |
| `audioMessage` (ptt=false) | `audio` | `audio/mpeg` | mp3, m4a, aac, ogg |
| `documentMessage` | `document` | `application/octet-stream` | pdf, doc, docx, xls, xlsx, txt, etc. |
| `stickerMessage` | `image` | `image/webp` | webp |

## Data Flow

```
WAMessage (Baileys)
       │
       ▼
detectWhatsAppMedia(msg.message)
       │
       ├─▶ null (no media)
       │
       ▼
WhatsAppMediaInfo { type, mimeType, fileLength?, filename? }
       │
       ▼
downloadWhatsAppMedia(msg, sock, options)
       │
       ├─▶ null (too large / download failed)
       │
       ▼
MessageAttachment { path, type, mimeType, sizeBytes?, filename? }
       │
       ▼
Saved to: {workspace}/inbox/{timestamp}-{type}.{ext}
```

## Implementation

### Detection

```typescript
// src/adapters/whatsapp-media.ts
function detectWhatsAppMedia(message: proto.IMessage): WhatsAppMediaInfo | null
```

Checks message for media fields in order:
1. `audioMessage?.ptt` → voice note
2. `audioMessage` → audio
3. `imageMessage` → image
4. `videoMessage` → video
5. `documentMessage` → document
6. `stickerMessage` → image

### Download

```typescript
// src/adapters/whatsapp-media.ts
async function downloadWhatsAppMedia(
  msg: WAMessage,
  sock: WASocket,
  options: MediaDownloadOptions,
): Promise<MessageAttachment | null>
```

Uses Baileys' `downloadMediaMessage()`:

```typescript
const buffer = await downloadMediaMessage(
  msg,
  "buffer",
  {},
  {
    logger: silentLogger,
    reuploadRequest: sock.updateMediaMessage,
  },
);
```

### Adapter Integration

```typescript
// src/adapters/whatsapp.ts
createWhatsAppBaileysAdapter({
  mediaEnabled: true,
  mediaMaxSizeBytes: 10 * 1024 * 1024,
  getGroupWorkspace: (groupId) => ensureGroupWorkspace(groupsDir, groupId),
});
```

## Size Limits

Files are checked against `mediaMaxSizeBytes` twice:

1. **Before download** — using `fileLength` from message metadata (may be missing)
2. **After download** — using actual buffer size

Files exceeding the limit are logged and skipped:

```
[WARN] Skipping large media file messageId=ABC type=video sizeBytes=52428800 maxBytes=10485760
```

## Reply Context

When replying to a message with media, the reply context includes media info:

```typescript
// Attributes added to <reply_to>
media_type="image"
media_mime="image/jpeg"
```

Example:
```xml
<reply_to name="John" jid="123@wa" message_id="ABC" media_type="image" media_mime="image/jpeg">
[image]
</reply_to>
```

## File Naming

Pattern: `{timestamp}-{type}.{ext}` or `{timestamp}-{filename}` for documents

| Input | Output |
|-------|--------|
| image/jpeg | `1709012345-image.jpg` |
| audio/ogg (voice) | `1709012345-voice.ogg` |
| application/pdf, "report.pdf" | `1709012345-report.pdf` |

## MIME to Extension Mapping

```typescript
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
  // ... etc
};
```

Unknown MIME types default to `.bin`.

## Limitations

1. **No re-download** — Media is downloaded once when the message arrives. If the file is deleted, it's gone.

2. **No transcription** — Voice notes are saved as audio files. pi cannot play them. Future: add Whisper transcription.

3. **Reply context doesn't include file** — When replying to a media message, we include metadata but not the actual file path. The original attachment would need to be looked up.

4. **Ephemeral media** — WhatsApp media URLs expire. Download must happen immediately when the message arrives.

## Error Handling

| Error | Behavior |
|-------|----------|
| Download fails | Log error, continue without attachment |
| Buffer empty | Log error, return null |
| Size exceeded | Log warning, discard buffer |
| Write fails | Throw error (propagates up) |
