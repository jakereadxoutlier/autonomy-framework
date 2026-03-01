#!/usr/bin/env bash
# dispatch.sh — Reliable task dispatch with 4-tier fallback
#
# Dispatches a task through the most reliable available channel:
#   1. Task Server HTTP API (localhost:4247) — fastest, most reliable
#   2. Bridge daemon file drop (evolution/requests/)
#   3. OpenClaw sessions_spawn (if CLI available, 3s timeout)
#   4. Deferred task queue (evolution/signals/deferred-tasks.jsonl)
#
# All attempts are logged to evolution/signals/dispatch-log.jsonl
#
# Usage:
#   dispatch.sh "task title" "task description"
#   dispatch.sh "task title" --file /path/to/body.md
#   dispatch.sh --request /path/to/existing-request.md
#
# Exit codes:
#   0 = dispatched successfully via tier 1, 2, 3, or 4
#   1 = invalid arguments

set -euo pipefail

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
REQUESTS_DIR="$CLAWD/evolution/requests"
SIGNALS_DIR="$CLAWD/evolution/signals"
DISPATCH_LOG="$SIGNALS_DIR/dispatch-log.jsonl"
DEFERRED_TASKS="$SIGNALS_DIR/deferred-tasks.jsonl"
BRIDGE_DAEMON="$CLAWD/evolution/bridge-daemon.js"
BRIDGE_PID_PATTERN="node.*bridge-daemon"
TASK_SERVER_PORT="${TASK_SERVER_PORT:-4247}"

mkdir -p "$REQUESTS_DIR" "$SIGNALS_DIR"

# --- Helpers ---

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

local_timestamp() {
  date +"%Y-%m-%dT%H%M"
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40
}

log_dispatch() {
  local tier="$1" status="$2" detail="$3" target="${4:-}"
  local entry="{\"ts\":\"$(timestamp)\",\"tier\":$tier,\"status\":\"$status\",\"detail\":\"$detail\",\"target\":\"$target\"}"
  echo "$entry" >> "$DISPATCH_LOG"
}

is_bridge_running() {
  pgrep -f "$BRIDGE_PID_PATTERN" > /dev/null 2>&1
}

is_task_server_running() {
  curl -s --max-time 1 "http://127.0.0.1:${TASK_SERVER_PORT}/health" > /dev/null 2>&1
}

# --- Argument Parsing ---

TITLE=""
BODY=""
REQUEST_FILE=""
PRIORITY="${DISPATCH_PRIORITY:-P2-normal}"

if [[ $# -eq 0 ]]; then
  echo "Usage: dispatch.sh \"task title\" \"task description\""
  echo "       dispatch.sh \"task title\" --file /path/to/body.md"
  echo "       dispatch.sh --request /path/to/existing-request.md"
  exit 1
fi

if [[ "$1" == "--request" ]]; then
  REQUEST_FILE="${2:?Missing request file path}"
  if [[ ! -f "$REQUEST_FILE" ]]; then
    echo "Error: Request file not found: $REQUEST_FILE"
    exit 1
  fi
  TITLE=$(head -1 "$REQUEST_FILE" | sed 's/^# //' | sed 's/^Request: //')
  BODY=$(cat "$REQUEST_FILE")
else
  TITLE="$1"
  if [[ "${2:-}" == "--file" ]]; then
    BODY=$(cat "${3:?Missing file path}")
  else
    BODY="${2:?Missing task description}"
  fi
fi

SLUG=$(slugify "$TITLE")
FILENAME="$(local_timestamp)-${SLUG}.md"

echo "Dispatching: $TITLE"

# --- Tier 1: Task Server HTTP API (fastest, most reliable) ---

if is_task_server_running; then
  echo "  Tier 1: Trying task server API..."
  # Build JSON payload safely with python3
  JSON_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
    'title': sys.argv[1],
    'body': sys.argv[2],
    'from': 'dispatch.sh',
    'priority': sys.argv[3],
}))
" "$TITLE" "$BODY" "$PRIORITY" 2>/dev/null || echo "")

  if [[ -n "$JSON_PAYLOAD" ]]; then
    RESPONSE=$(curl -s --max-time 5 -X POST \
      -H "Content-Type: application/json" \
      -d "$JSON_PAYLOAD" \
      "http://127.0.0.1:${TASK_SERVER_PORT}/task" 2>/dev/null || echo "")

    if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('id')" 2>/dev/null; then
      TASK_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
      log_dispatch 1 "success" "$TITLE" "task-server:$TASK_ID"
      echo "  ✓ Dispatched via task server (ID: $TASK_ID)"
      exit 0
    fi
  fi
  log_dispatch 1 "failed" "task server POST failed for: $TITLE" "task-server"
  echo "  ✗ Task server POST failed, falling through..."
else
  log_dispatch 1 "skipped" "task server not running" "task-server"
  echo "  - Task server not running, skipping tier 1"
fi

# --- Tier 2: Bridge daemon file drop ---

echo "  Tier 2: Trying bridge daemon file drop..."

if is_bridge_running; then
  REQ_PATH="$REQUESTS_DIR/$FILENAME"
  if [[ -n "$REQUEST_FILE" ]]; then
    if grep -q 'Status:\*\* pending' "$REQUEST_FILE" 2>/dev/null; then
      cp "$REQUEST_FILE" "$REQ_PATH"
    else
      cat > "$REQ_PATH" <<BRIDGE_EOF
# Request: $TITLE
- **From:** dispatch.sh
- **Priority:** $PRIORITY
- **Type:** capability-gap
- **Status:** pending

## Task
$(cat "$REQUEST_FILE")
BRIDGE_EOF
    fi
  else
    cat > "$REQ_PATH" <<BRIDGE_EOF
# Request: $TITLE
- **From:** dispatch.sh
- **Priority:** $PRIORITY
- **Type:** capability-gap
- **Status:** pending

## Task
$BODY
BRIDGE_EOF
  fi

  log_dispatch 2 "success" "$TITLE" "bridge:$FILENAME"
  echo "  ✓ Dropped request to bridge: $FILENAME"
  exit 0
else
  log_dispatch 2 "failed" "bridge daemon not running for: $TITLE" "bridge"
  echo "  ✗ Bridge daemon not running, falling through..."

  # Attempt restart
  CHECK_BRIDGE="$CLAWD/evolution/check-bridge.sh"
  if [[ -x "$CHECK_BRIDGE" ]]; then
    echo "  Attempting bridge restart..."
    if "$CHECK_BRIDGE" 2>/dev/null; then
      sleep 2
      if is_bridge_running; then
        REQ_PATH="$REQUESTS_DIR/$FILENAME"
        if [[ -n "$REQUEST_FILE" ]]; then
          cp "$REQUEST_FILE" "$REQ_PATH"
        else
          cat > "$REQ_PATH" <<RESTART_EOF
# Request: $TITLE
- **From:** dispatch.sh
- **Priority:** $PRIORITY
- **Type:** capability-gap
- **Status:** pending

## Task
$BODY
RESTART_EOF
        fi
        log_dispatch 2 "success" "bridge restarted, dropped: $TITLE" "bridge:$FILENAME"
        echo "  ✓ Bridge restarted. Dropped request: $FILENAME"
        exit 0
      fi
    fi
    echo "  ✗ Bridge restart failed"
  fi
fi

# --- Tier 3: OpenClaw sessions_spawn (3s timeout — fail fast) ---

if command -v openclaw &> /dev/null; then
  echo "  Tier 3: Trying openclaw sessions_spawn (3s timeout)..."
  if timeout 3 openclaw sessions_spawn --task "$TITLE" --body "$BODY" 2>/dev/null; then
    log_dispatch 3 "success" "$TITLE" "openclaw-spawn"
    echo "  ✓ Dispatched via openclaw sessions_spawn"
    exit 0
  else
    log_dispatch 3 "failed" "openclaw spawn timed out or errored" "openclaw-spawn"
    echo "  ✗ openclaw spawn failed, falling through..."
  fi
else
  log_dispatch 3 "skipped" "openclaw CLI not available" "openclaw-spawn"
fi

# --- Tier 4: Deferred task queue (always succeeds) ---

echo "  Tier 4: Queueing to deferred tasks..."

DEFERRED_ENTRY="{\"ts\":\"$(timestamp)\",\"title\":\"$TITLE\",\"filename\":\"$FILENAME\",\"status\":\"queued\",\"priority\":\"$PRIORITY\",\"body\":$(echo "$BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"(body encoding failed)\"")}"
echo "$DEFERRED_ENTRY" >> "$DEFERRED_TASKS"

log_dispatch 4 "success" "$TITLE" "deferred-queue"
echo "  ✓ Queued to deferred tasks (will be drained when task server starts)"
echo "  Run: evolution/check-bridge.sh to attempt restart"
exit 0
