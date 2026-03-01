#!/usr/bin/env bash
# install-task-server.sh — Install and start the task server LaunchAgent
#
# Copies the plist to ~/Library/LaunchAgents/ and bootstraps it.
# Safe to re-run (idempotent).

set -euo pipefail

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
PLIST_SRC="$CLAWD/evolution/ai.autonomy.taskserver.plist"
PLIST_DST="$HOME/Library/LaunchAgents/ai.autonomy.taskserver.plist"
LABEL="ai.autonomy.taskserver"

echo "Installing task server LaunchAgent..."

# Check node exists
NODE_BIN="$(which node 2>/dev/null)"
if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN=$(which node 2>/dev/null || echo "")
  if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found"
    exit 1
  fi
  echo "Note: Using node at $NODE_BIN (update plist if needed)"
fi

# Check task-server.js exists
if [[ ! -f "$CLAWD/evolution/task-server.js" ]]; then
  echo "ERROR: task-server.js not found at $CLAWD/evolution/task-server.js"
  exit 1
fi

# Copy plist
cp "$PLIST_SRC" "$PLIST_DST"
echo "  Copied plist to $PLIST_DST"

# Unload if already loaded (ignore errors)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1

# Load
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "  LaunchAgent loaded"

# Verify
sleep 2
if curl -s --max-time 2 "http://127.0.0.1:4247/health" > /dev/null 2>&1; then
  echo "  Task server is running on port 4247"
  curl -s "http://127.0.0.1:4247/health" | python3 -m json.tool 2>/dev/null || true
else
  echo "  WARNING: Task server may not be running yet. Check: curl http://127.0.0.1:4247/health"
fi

echo ""
echo "Done. Task server installed as LaunchAgent ($LABEL)."
echo "Endpoints: POST /task, GET /task/:id, GET /tasks, GET /health, POST /drain"
