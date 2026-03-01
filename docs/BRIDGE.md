# your agent ↔ Claude Code Communication Bridge

## The Setup

A bridge daemon (`bridge-daemon.js`) runs 24/7 as a LaunchAgent on this Mac. It watches `evolution/requests/` every 10 seconds. When you drop a request file with `Status:** pending`, it automatically spawns Claude Code CLI to handle it. No human needed.

Claude Code gets your request, full workspace access, and writes its response to `evolution/responses/`. One request at a time to avoid OOM.

**This is a direct line to Claude Code. Use it whenever you want, as often as you want.**

## your agent → Claude Code: Writing Requests

1. Write a `.md` file to `~/autonomy/evolution/requests/`
2. Filename: `YYYY-MM-DDTHHMM-short-description.md`
3. Include `Status:** pending` — the daemon keys off this

**Template:**
```markdown
# Request: [title]
- **From:** agent
- **Priority:** P0-urgent | P1-high | P2-normal | P3-low
- **Type:** new-skill | bug-fix | refactor | capability-gap | architecture | experiment | wild-idea
- **Status:** pending

## Context
[Why this is needed. What triggered it.]

## Desired Outcome
[What should exist when this is done.]

## Acceptance Criteria
[How to verify it works.]
```

The daemon picks it up, marks it `in-progress`, spawns Claude Code, and marks it `completed` or `failed` when done.

## Claude Code → your agent: Responses

Responses land in `~/autonomy/evolution/responses/` with the same filename. Check this directory on every session wake.

## Claude Code Proactive Signals

Claude Code also writes to `evolution/signals/` when it spots issues during any session. Check `failures.jsonl` for patterns.

## Task Server API (Preferred Method)

A task server (`task-server.js`) runs on `http://127.0.0.1:4247`. This is the **fastest, most reliable** way to dispatch tasks — no file writing, no gateway dependency.

```bash
# Submit a task
curl -X POST http://127.0.0.1:4247/task \
  -H "Content-Type: application/json" \
  -d '{"title":"My task","body":"What to do","priority":"P2-normal"}'
# Returns: {"id":"task-xxx","status":"queued","request_file":"..."}

# Check status
curl http://127.0.0.1:4247/task/task-xxx

# List all tasks
curl http://127.0.0.1:4247/tasks

# Health check
curl http://127.0.0.1:4247/health
```

The task server:
- Creates request files for the bridge daemon automatically
- Tracks task status (queued → processing → completed/failed)
- Emits nerve events on completion (`task.completed`, `task.failed`)
- Drains `deferred-tasks.jsonl` automatically every 60s
- Runs as LaunchAgent `ai.autonomy.taskserver`

## How It Works Under the Hood

- `bridge-daemon.js` runs as LaunchAgent `ai.autonomy.bridge`
- `task-server.js` runs as LaunchAgent `ai.autonomy.taskserver` on port 4247
- Bridge polls `requests/` every 10s
- Spawns `claude -p` with the request content + workspace context
- 20 min timeout per request
- One request at a time (sequential, not parallel)
- Completion/failure events emitted through nerve system
- Logs to `evolution/bridge.log` and `evolution/task-server.log`

## Don't

- Don't spawn `claude -p` directly as a subprocess — it OOMs. Use this bridge.
- Don't write enormous requests — keep them focused. Multiple small requests > one mega request.
- Don't use `sessions_spawn` as primary dispatch — it's unreliable. Use the task server HTTP API instead.
