#!/usr/bin/env bash
# check-bridge.sh — Monitor and restart the bridge daemon
#
# Checks if the bridge daemon (bridge-daemon.js) is alive.
# If dead, restarts it via launchctl.
# Logs all events to evolution/signals/dispatch-log.jsonl
#
# Safe to run from cron, dispatch.sh, or manually. Idempotent.
#
# Exit codes:
#   0 = bridge is running (was already running, or successfully restarted)
#   1 = bridge could not be restarted

set -euo pipefail

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
SIGNALS_DIR="$CLAWD/evolution/signals"
DISPATCH_LOG="$SIGNALS_DIR/dispatch-log.jsonl"
BRIDGE_DAEMON="$CLAWD/evolution/bridge-daemon.js"
BRIDGE_LOG="$CLAWD/evolution/bridge.log"
LAUNCH_AGENT_LABEL="ai.autonomy.bridge"
BRIDGE_PID_PATTERN="node.*bridge-daemon"

# Node binary from the LaunchAgent plist
NODE_BIN="$(which node 2>/dev/null)"
if [[ ! -x "$NODE_BIN" ]]; then
  # Fallback to whatever node is in PATH
  NODE_BIN=$(which node 2>/dev/null || echo "")
fi

mkdir -p "$SIGNALS_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log_event() {
  local status="$1" detail="$2"
  local entry="{\"ts\":\"$(timestamp)\",\"type\":\"bridge-health\",\"status\":\"$status\",\"detail\":\"$detail\"}"
  echo "$entry" >> "$DISPATCH_LOG"
}

is_bridge_running() {
  pgrep -f "$BRIDGE_PID_PATTERN" > /dev/null 2>&1
}

get_bridge_pid() {
  pgrep -f "$BRIDGE_PID_PATTERN" 2>/dev/null | head -1
}

# --- Check current status ---

if is_bridge_running; then
  PID=$(get_bridge_pid)
  echo "Bridge daemon is running (PID: $PID)"
  log_event "healthy" "Bridge running, PID=$PID"
  exit 0
fi

echo "Bridge daemon is NOT running. Attempting restart..."
log_event "down" "Bridge daemon not found, attempting restart"

# --- Restart Strategy 1: launchctl ---

# Try to restart via launchctl (preferred — matches LaunchAgent config)
if launchctl list "$LAUNCH_AGENT_LABEL" &>/dev/null; then
  echo "  Restarting via launchctl (kickstart)..."
  # bootout + bootstrap = clean restart
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null || true
  sleep 3

  if is_bridge_running; then
    PID=$(get_bridge_pid)
    echo "  ✓ Bridge restarted via launchctl (PID: $PID)"
    log_event "restarted" "Via launchctl kickstart, PID=$PID"
    exit 0
  fi

  # If kickstart didn't work, try bootstrap
  echo "  kickstart failed, trying bootout + bootstrap..."
  PLIST="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
  if [[ -f "$PLIST" ]]; then
    launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    sleep 3

    if is_bridge_running; then
      PID=$(get_bridge_pid)
      echo "  ✓ Bridge restarted via bootstrap (PID: $PID)"
      log_event "restarted" "Via launchctl bootstrap, PID=$PID"
      exit 0
    fi
  fi
fi

# --- Restart Strategy 2: Direct node spawn ---

echo "  launchctl restart failed. Spawning node directly..."

if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  echo "  ✗ No node binary found. Cannot restart bridge."
  log_event "failed" "No node binary available for direct spawn"
  exit 1
fi

if [[ ! -f "$BRIDGE_DAEMON" ]]; then
  echo "  ✗ Bridge daemon script not found: $BRIDGE_DAEMON"
  log_event "failed" "bridge-daemon.js not found at $BRIDGE_DAEMON"
  exit 1
fi

# Spawn in background, redirect output to bridge logs
nohup "$NODE_BIN" "$BRIDGE_DAEMON" >> "$BRIDGE_LOG" 2>> "$CLAWD/evolution/bridge-stderr.log" &
SPAWN_PID=$!
disown "$SPAWN_PID" 2>/dev/null || true

sleep 3

if is_bridge_running; then
  PID=$(get_bridge_pid)
  echo "  ✓ Bridge restarted via direct spawn (PID: $PID)"
  log_event "restarted" "Via direct node spawn, PID=$PID"
  exit 0
fi

# --- All restart methods failed ---

echo "  ✗ All restart methods failed."
echo "  Manual fix: launchctl load ~/Library/LaunchAgents/ai.autonomy.bridge.plist"
log_event "failed" "All restart methods exhausted"
exit 1
