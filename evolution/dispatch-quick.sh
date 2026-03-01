#!/usr/bin/env bash
# dispatch-quick.sh — Zero-friction task dispatch. ALWAYS succeeds.
#
# This is the fastest way to dispatch work OUT of the main chat.
# If the task server is up, uses HTTP. Otherwise drops a file.
# If both fail, appends to deferred queue (never fails).
#
# Usage:
#   dispatch-quick.sh "title" "body"
#   dispatch-quick.sh "title" "body" "P0-urgent"
#
# Examples:
#   dispatch-quick.sh "Research X topic" "Find out about X and write summary to garden/seeds/x.md"
#   dispatch-quick.sh "Build feature Y" "Create a script that does Y. Acceptance: Y works."
#   dispatch-quick.sh "Fix bug Z" "The Z system is broken because..." "P0-urgent"
#
# Exit: always 0. Work WILL be done, even if deferred.

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
REQUESTS_DIR="$CLAWD/evolution/requests"
SIGNALS_DIR="$CLAWD/evolution/signals"
DEFERRED="$SIGNALS_DIR/deferred-tasks.jsonl"
PORT="${TASK_SERVER_PORT:-4247}"

TITLE="${1:?Usage: dispatch-quick.sh \"title\" \"body\" [priority]}"
BODY="${2:?Usage: dispatch-quick.sh \"title\" \"body\" [priority]}"
PRIORITY="${3:-P2-normal}"

mkdir -p "$REQUESTS_DIR" "$SIGNALS_DIR"

# --- Tier 1: Task server HTTP (fastest) ---
RESPONSE=$(curl -s --max-time 3 -X POST \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"$TITLE\",\"body\":\"$BODY\",\"priority\":\"$PRIORITY\",\"from\":\"dispatch-quick\"}" \
  "http://127.0.0.1:${PORT}/task" 2>/dev/null || echo "")

if echo "$RESPONSE" | grep -q '"id"'; then
  echo "dispatched:task-server"
  exit 0
fi

# --- Tier 2: File drop (bridge daemon) ---
TS=$(date +%Y-%m-%dT%H%M)
SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 40)
FILENAME="${TS}-${SLUG}.md"
REQPATH="$REQUESTS_DIR/$FILENAME"

cat > "$REQPATH" << ENDREQ
# Request: $TITLE
- **From:** dispatch-quick
- **Priority:** $PRIORITY
- **Type:** capability-gap
- **Status:** pending

## Task
$BODY
ENDREQ

# Check if bridge daemon is running
if pgrep -f "node.*bridge-daemon" > /dev/null 2>&1; then
  echo "dispatched:bridge:$FILENAME"
  exit 0
fi

# --- Tier 3: Deferred queue (always works) ---
echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"title\":\"$TITLE\",\"body\":\"$BODY\",\"priority\":\"$PRIORITY\",\"status\":\"queued\"}" >> "$DEFERRED"
echo "dispatched:deferred"
exit 0
