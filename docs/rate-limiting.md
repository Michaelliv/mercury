# Rate Limiting

Mercury rate limits messages per-user per-group to prevent abuse. This protects against users flooding the agent or bot loops exhausting resources.

## How It Works

```
Message received
  │
  ├─► Route (trigger check, permissions)
  │
  ├─► Type = "assistant"?
  │     │
  │     ├─► Check rate limit
  │     │     • Key: groupId:userId
  │     │     • Count requests in sliding window
  │     │     • Compare against effective limit
  │     │
  │     ├─► Under limit → record request → continue
  │     └─► Over limit → return "Rate limit exceeded"
  │
  └─► Type = "command" / "ignore" → bypass rate limit
```

Commands like `stop` and `compact` bypass rate limiting so users can always abort runaway containers.

## Configuration

| Config | Env Var | Default | Range |
|--------|---------|---------|-------|
| `rateLimitPerUser` | `MERCURY_RATE_LIMIT_PER_USER` | 10 | 1 – 1000 |
| `rateLimitWindowMs` | `MERCURY_RATE_LIMIT_WINDOW_MS` | 60000 (1 min) | 1s – 1h |

```bash
# Allow 5 requests per user per group per minute
export MERCURY_RATE_LIMIT_PER_USER=5
export MERCURY_RATE_LIMIT_WINDOW_MS=60000
```

## Per-Group Override

Groups can set a custom limit via `mrctl` or the API:

```bash
# Inside agent container (group context is automatic)
mrctl config set rate_limit 5

# Via API with explicit group
curl -X PUT http://localhost:8787/api/config \
  -H "X-Mercury-Group: slack:C123" \
  -H "X-Mercury-Caller: slack:U456" \
  -H "Content-Type: application/json" \
  -d '{"key": "rate_limit", "value": "5"}'
```

The per-group `rate_limit` config takes precedence over the global `MERCURY_RATE_LIMIT_PER_USER`.

## Behavior

| Scenario | Result |
|----------|--------|
| Under limit | Request proceeds normally |
| Over limit | Returns `{ type: "denied", reason: "Rate limit exceeded. Try again shortly." }` |
| Command (stop, compact) | Always allowed, bypasses rate limit |
| Ignored message | Not counted toward limit |
| Different user | Separate limit bucket |
| Different group | Separate limit bucket |

## Algorithm

Uses a sliding window approach:

1. Key is `${groupId}:${userId}`
2. Each request timestamp is stored in an array
3. On check: filter to timestamps within window, count
4. If count < limit: record new timestamp, allow
5. If count >= limit: reject

Expired entries are cleaned up periodically (every 60s) to prevent memory leaks.

## API

### `RateLimiter`

```ts
const limiter = new RateLimiter(maxRequests, windowMs);

limiter.isAllowed(groupId, userId)           // Check + record, returns boolean
limiter.isAllowed(groupId, userId, override) // With per-call limit override
limiter.getRemaining(groupId, userId)        // Requests left in window
limiter.startCleanup(intervalMs?)            // Start periodic cleanup (default 60s)
limiter.stopCleanup()                        // Stop cleanup timer
limiter.cleanup()                            // Manual cleanup, returns removed count
limiter.clear()                              // Reset all state
limiter.bucketCount                          // Number of tracked user/group pairs
```

### `MercuryCoreRuntime`

```ts
runtime.rateLimiter                          // Access the rate limiter instance
```

The rate limiter is initialized in the constructor and starts cleanup in `runtime.initialize()`.

## Example

```
User sends 10 messages in quick succession:

Message 1:  ✓ allowed (1/10)
Message 2:  ✓ allowed (2/10)
...
Message 10: ✓ allowed (10/10)
Message 11: ✗ denied — "Rate limit exceeded. Try again shortly."
Message 12: ✗ denied

[60 seconds pass, window slides]

Message 13: ✓ allowed (1/10)
```

## See Also

- [pipeline.md](./pipeline.md) — Message flow and routing
- [container-lifecycle.md](./container-lifecycle.md) — Container timeouts (another abuse protection)
