#!/usr/bin/env bash
# health-monitor.sh — Check system health, call alert.sh on failures
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ALERT="$DIR/alert.sh"

# 1. Bridge daemon
if ! pgrep -f bridge-daemon.js > /dev/null 2>&1; then
  "$ALERT" "BRIDGE DOWN: bridge-daemon.js not running"
fi

# 2. Nerve daemon socket
if [ ! -e "${AGENT_HOME:-$HOME/autonomy}/nerve/bus.sock" ]; then
  "$ALERT" "NERVE DOWN: bus.sock missing"
fi

# 3. Disk usage
DISK_PCT=$(df -h / | awk 'NR==2{print $5}' | sed 's/%//')
if [ "$DISK_PCT" -gt 90 ] 2>/dev/null; then
  "$ALERT" "DISK CRITICAL: ${DISK_PCT}% full"
fi

# 4. Stuck bridge requests (>20 min processing)
BRIDGE_LOG="${AGENT_HOME:-$HOME/autonomy}/evolution/bridge.log"
if [ -f "$BRIDGE_LOG" ]; then
  NOW=$(date +%s)
  grep -i "processing\|started" "$BRIDGE_LOG" | tail -5 | while read -r line; do
    # Try to extract timestamp from log line
    LOG_TS=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}' | head -1)
    if [ -n "$LOG_TS" ]; then
      LOG_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M" "$LOG_TS" +%s 2>/dev/null || echo 0)
      if [ "$LOG_EPOCH" -gt 0 ]; then
        DIFF=$(( (NOW - LOG_EPOCH) / 60 ))
        if [ "$DIFF" -gt 20 ]; then
          "$ALERT" "BRIDGE STUCK: Request processing for ${DIFF} minutes"
        fi
      fi
    fi
  done
fi

echo "Health check complete"
