# Container Lifecycle

Mercury runs agent code inside Docker containers. This document covers how containers are managed, what happens when they fail, and how the system recovers.

## Container Identity

Each container is tagged for tracking and cleanup:

| Property | Format | Purpose |
|----------|--------|---------|
| **Name** | `mercury-<timestamp>-<id>` | Unique identifier for logging/debugging |
| **Label** | `mercury.managed=true` | Identifies mercury-owned containers for cleanup |

Example:
```
docker ps --filter "label=mercury.managed=true"
CONTAINER ID   IMAGE              NAMES
a1b2c3d4e5f6   mercury-agent     mercury-1709312456789-1
```

## Timeout

Containers have a maximum runtime to prevent runaway processes.

| Config | Env Var | Default | Range |
|--------|---------|---------|-------|
| `containerTimeoutMs` | `MERCURY_CONTAINER_TIMEOUT_MS` | 5 minutes | 10s – 1h |

When a container exceeds the timeout:
1. Container is killed via `docker kill`
2. `ContainerError` thrown with `reason: "timeout"`
3. User sees: "Container timed out."
4. Queue unblocks, next message can proceed

## Error Types

Container failures are classified by `ContainerError`:

| Reason | Exit Code | Cause | User Message |
|--------|-----------|-------|--------------|
| `timeout` | — | Exceeded `containerTimeoutMs` | "Container timed out." |
| `oom` | 137 | SIGKILL (OOM, resource limits, or manual kill) | "Container was killed (possibly out of memory)." |
| `aborted` | — | User sent `stop` command | "Stopped current run." |
| `error` | non-zero | Agent crashed or failed | *(error thrown, logged)* |

Exit code 137 = 128 + 9 (SIGKILL), typically from Docker's OOM killer.

## Orphan Cleanup

If the host process crashes or restarts while containers are running, those containers become orphans. On startup, mercury cleans them up:

```
Startup
  │
  └─► runtime.initialize()
        │
        └─► containerRunner.cleanupOrphans()
              │
              ├─► docker ps -a --filter "label=mercury.managed=true"
              ├─► docker rm -f <container-ids>
              └─► Log: "Cleaned up N orphaned container(s)"
```

This ensures:
- No zombie containers consuming resources
- No blocked group queues from previous runs
- Clean state before accepting new work

## Lifecycle Diagram

```
Message received
  │
  ├─► Queue (one per group)
  │
  ├─► Spawn container
  │     • --name mercury-<ts>-<id>
  │     • --label mercury.managed=true
  │     • --rm (auto-remove on exit)
  │
  ├─► Start timeout timer
  │
  ├─► Wait for completion
  │     │
  │     ├─► Success (exit 0) → parse reply + scan outbox/ → respond
  │     ├─► Timeout → kill container → ContainerError(timeout)
  │     ├─► OOM (exit 137) → ContainerError(oom)
  │     ├─► Aborted → ContainerError(aborted)
  │     └─► Other failure → ContainerError(error)
  │
  └─► Cleanup
        • Clear timeout timer
        • Remove from tracking map
        • Queue unblocks (finally block)
```

## Configuration

```bash
# Set container timeout to 10 minutes
export MERCURY_CONTAINER_TIMEOUT_MS=600000

# Use a preset image from GitHub Container Registry
export MERCURY_AGENT_IMAGE=ghcr.io/michaelliv/mercury-agent:latest   # Full (default)
export MERCURY_AGENT_IMAGE=ghcr.io/michaelliv/mercury-agent:minimal  # Lightweight
```

## Agent Image Presets

Mercury publishes two image presets to GitHub Container Registry:

| Preset | Size | Contents |
|--------|------|----------|
| `ghcr.io/michaelliv/mercury-agent:latest` | ~2.8GB | Full devcontainer: Bun, Node.js, Python, Go, git, build tools |
| `ghcr.io/michaelliv/mercury-agent:minimal` | ~1.9GB | Bun only: Bun runtime, pi, agent-browser, napkin |

Images are published on each release. Version-specific tags are also available (e.g., `:0.2.0`, `:0.2.0-minimal`).

### Building Locally

To build images locally instead of pulling from the registry:
```bash
./container/build.sh all      # Both presets
./container/build.sh latest   # Full image only (default)
./container/build.sh minimal  # Lightweight image only
```

Then use `mercury-agent:latest` or `mercury-agent:minimal` (without the ghcr.io prefix).

## Custom Agent Images

You can use custom Docker images via `MERCURY_AGENT_IMAGE`.

### Requirements

Your image **must** have:
- `bun` runtime
- `pi` CLI (`@mariozechner/pi-coding-agent`)
- `agent-browser` CLI
- `napkin` CLI (`napkin-ai`)
- `mrctl` (copied during build)

### Entry Point

The image must use this entrypoint:
```dockerfile
ENTRYPOINT ["bun", "run", "/app/src/agent/container-entry.ts"]
```

### Required Files

Copy these files into your image at `/app/`:
```dockerfile
COPY src/agent/container-entry.ts /app/src/agent/container-entry.ts
COPY src/cli/mrctl.ts /app/src/cli/mrctl.ts
COPY src/extensions/reserved.ts /app/src/extensions/reserved.ts
COPY src/types.ts /app/src/types.ts
```

### mrctl Setup

Create the mrctl wrapper:
```dockerfile
RUN echo '#!/bin/sh\nbun run /app/src/cli/mrctl.ts "$@"' > /usr/local/bin/mrctl && \
    chmod +x /usr/local/bin/mrctl
```

### Volume Mounts

Mercury mounts these paths into containers:
- `/groups` — Group workspaces (read/write)
- `/home/node/.pi/agent` — Global agent config (read/write)
- `/docs/mercury/` — Self-documentation (read-only)

### Example Custom Dockerfile

```dockerfile
FROM your-base-image:tag

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install required CLIs
RUN bun add -g @mariozechner/pi-coding-agent agent-browser napkin-ai

# Install Playwright for browser automation (optional but recommended)
RUN bunx playwright install chromium

WORKDIR /app

# Copy Mercury agent files
COPY src/agent/container-entry.ts /app/src/agent/container-entry.ts
COPY src/cli/mrctl.ts /app/src/cli/mrctl.ts
COPY src/extensions/reserved.ts /app/src/extensions/reserved.ts
COPY src/types.ts /app/src/types.ts

# Setup mrctl
RUN echo '#!/bin/sh\nbun run /app/src/cli/mrctl.ts "$@"' > /usr/local/bin/mrctl && \
    chmod +x /usr/local/bin/mrctl

ENTRYPOINT ["bun", "run", "/app/src/agent/container-entry.ts"]
```

### Validation

When using a custom image (not `mercury-agent:*`), Mercury logs a warning at startup:
```
WARN  Using custom agent image
      image: your-image:tag
      note: Ensure image has: bun, pi, agent-browser, napkin, mrctl
```

## API

### `AgentContainerRunner`

```ts
runner.cleanupOrphans()     // Remove orphaned containers (called on startup)
runner.reply(input)         // Run container, returns ContainerResult (reply + outbox files)
runner.abort(groupId)       // Kill container for a group
runner.killAll()            // Kill all running containers (shutdown)
runner.isRunning(groupId)   // Check if container is active
runner.activeCount          // Number of running containers
```

### `MercuryCoreRuntime`

```ts
await runtime.initialize()  // Call before accepting work (runs orphan cleanup)
```

### `ContainerError`

```ts
import { ContainerError } from "./agent/container-error.js";

// Properties
error.reason    // "timeout" | "oom" | "aborted" | "error"
error.exitCode  // number | null
error.message   // Human-readable description

// Factory methods
ContainerError.timeout(groupId)
ContainerError.oom(groupId, exitCode)
ContainerError.aborted(groupId)
ContainerError.error(exitCode, output)
```
