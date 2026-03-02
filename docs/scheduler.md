# Scheduler

Mercury includes a task scheduler for automated prompts. Tasks can run on **cron schedules** (recurring) or **at schedules** (one-shot).

## Task Types

### Cron Tasks (Recurring)

Run on a cron schedule, repeating indefinitely:

```bash
# Daily standup at 9am
mercury-ctl tasks create --cron "0 9 * * *" --prompt "Good morning! What's on the agenda today?"
```

### At Tasks (One-Shot)

Run once at a specific time, then auto-delete:

```bash
# Reminder in 2 hours
mercury-ctl tasks create --at "2026-03-02T16:00:00Z" --prompt "Time for the team meeting!"

# Schedule a future check
mercury-ctl tasks create --at "2026-03-15T09:00:00Z" --prompt "Follow up on the Q1 report"
```

At-tasks are useful for:
- **Reminders** — one-time notifications
- **Delayed actions** — schedule something for later
- **Follow-ups** — check back on something at a specific time

The `at` timestamp must be:
- ISO 8601 format (e.g., `2026-03-02T14:00:00Z`)
- In the future

## Silent Tasks

Tasks can be marked as **silent** to execute without posting results to the chat. This is useful for:

- **Maintenance tasks** — cleanup, archiving, or housekeeping
- **Health checks** — periodic monitoring without noise
- **Background updates** — knowledge base updates, data syncing

The task executes normally but no message is sent to the group.

```bash
# Create a silent cron task
mercury-ctl tasks create --cron "0 3 * * *" --prompt "Run nightly maintenance" --silent

# Create a silent at-task
mercury-ctl tasks create --at "2026-03-02T03:00:00Z" --prompt "One-time cleanup" --silent
```

## How It Works

```
TaskScheduler.start()
  │
  └─► Poll loop (every 5 seconds)
        │
        ├─► Query DB for due tasks (active=1, next_run_at <= now)
        │
        ├─► For each due task:
        │     │
        │     ├─► [Cron task]
        │     │     ├─► Compute next run time from cron expression
        │     │     ├─► Update next_run_at in DB
        │     │     └─► Execute handler
        │     │
        │     └─► [At task]
        │           ├─► Execute handler
        │           └─► Delete task from DB
        │
        └─► Schedule next poll
```

Tasks are processed sequentially within a poll cycle. Each task runs as if the `createdBy` user sent the prompt.

**At-task lifecycle:**
1. Created with a future timestamp
2. Waits until scheduled time
3. Executes once
4. Auto-deletes (regardless of success/failure)

## Creating Tasks

The agent creates tasks via `mercury-ctl`:

```bash
# === Cron tasks (recurring) ===

# Daily standup at 9am
mercury-ctl tasks create --cron "0 9 * * *" --prompt "Good morning! What's on the agenda today?"

# Weekly summary on Fridays at 5pm
mercury-ctl tasks create --cron "0 17 * * 5" --prompt "Generate a summary of this week's discussions."

# Every 6 hours
mercury-ctl tasks create --cron "0 */6 * * *" --prompt "Check for any pending items."

# Silent nightly cleanup (no chat output)
mercury-ctl tasks create --cron "0 3 * * *" --prompt "Clean up old temp files" --silent

# === At tasks (one-shot) ===

# Reminder at a specific time
mercury-ctl tasks create --at "2026-03-02T14:00:00Z" --prompt "Meeting starts in 15 minutes!"

# Delayed follow-up
mercury-ctl tasks create --at "2026-03-10T09:00:00Z" --prompt "Check if the deployment completed successfully"
```

**Note:** You must specify either `--cron` or `--at`, not both.

## Managing Tasks

```bash
# List all tasks in the current group
mercury-ctl tasks list

# Pause a task (stops execution, keeps definition)
mercury-ctl tasks pause <id>

# Resume a paused task
mercury-ctl tasks resume <id>

# Manually trigger a task now
mercury-ctl tasks run <id>

# Delete a task permanently
mercury-ctl tasks delete <id>
```

## Cron Format

Standard 5-field cron expressions:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

Examples:

| Expression | Description |
|------------|-------------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 */6 * * *` | Every 6 hours |
| `0 17 * * 5` | Fridays at 5:00 PM |
| `0 0 1 * *` | First day of each month at midnight |

Mercury uses [cron-parser](https://www.npmjs.com/package/cron-parser) for parsing.

## Task Execution

When a task fires:

1. The prompt is sent to the group as if from the task creator
2. Runs through the normal routing (trigger check bypassed for scheduled tasks)
3. Caller ID is the `createdBy` user
4. Permissions are checked against the creator's role at execution time

Tasks run with `system` caller privileges for the routing layer, but the prompt is attributed to the original creator.

## Storage

Tasks are stored in SQLite:

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  cron TEXT,                          -- Cron expression (null for at-tasks)
  at TEXT,                            -- ISO 8601 timestamp (null for cron-tasks)
  prompt TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  silent INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_next ON tasks(active, next_run_at);
```

| Column | Description |
|--------|-------------|
| `cron` | Cron expression for recurring tasks (null for at-tasks) |
| `at` | ISO 8601 timestamp for one-shot tasks (null for cron-tasks) |
| `silent` | If 1, task runs but doesn't post results to chat |

## Permissions

Task management requires specific permissions:

| Permission | Action |
|------------|--------|
| `tasks.list` | View scheduled tasks |
| `tasks.create` | Create new tasks |
| `tasks.pause` | Pause a task |
| `tasks.resume` | Resume a paused task |
| `tasks.delete` | Delete a task |

By default, only `admin` has these permissions. Grant to other roles:

```bash
mercury-ctl permissions set member prompt,tasks.list
mercury-ctl permissions set moderator prompt,tasks.list,tasks.pause,tasks.resume
```

## Lifecycle

```
mercury run
  │
  ├─► runtime.initialize()
  │
  ├─► scheduler.start(handler)
  │     └─► Poll loop begins
  │
  ├─► ... running ...
  │
  └─► SIGTERM/SIGINT
        └─► scheduler.stop()
              └─► Poll loop ends (graceful)
```

The scheduler stops cleanly on shutdown — no orphaned timers.

## API

### `TaskScheduler`

```typescript
const scheduler = new TaskScheduler(db, pollIntervalMs);

scheduler.start(handler);    // Begin polling
scheduler.stop();            // Stop polling
scheduler.computeNextRun(cron, from);  // Get next run time for cron tasks
```

### Handler Signature

```typescript
type TaskHandler = (task: {
  id: number;
  groupId: string;
  prompt: string;
  createdBy: string;
  silent: boolean;
}) => Promise<void>;
```

### Database Methods

```typescript
// Create a cron task
db.createTask(groupId, { cron: "0 9 * * *" }, prompt, nextRunAt, createdBy, silent);

// Create an at-task
db.createTask(groupId, { at: "2026-03-02T14:00:00Z" }, prompt, nextRunAt, createdBy, silent);

db.listTasks(groupId?);       // List tasks (optionally filter by group)
db.getDueTasks(now);          // Get tasks ready to run
db.getTask(id);               // Get single task
db.setTaskActive(id, active); // Pause/resume
db.deleteTask(id, groupId);   // Delete task (with group check)
db.deleteTaskById(id);        // Delete task (no group check, for scheduler)
db.updateTaskNextRun(id, nextRunAt);  // Update next execution time
```

## Error Handling

If a task handler fails:
- Error is logged
- Task is not retried in the same cycle
- **Cron tasks:** `next_run_at` is already updated, so it will run again at the next scheduled time
- **At tasks:** Still deleted after execution (one-shot behavior preserved)
- Other tasks in the cycle continue to execute
