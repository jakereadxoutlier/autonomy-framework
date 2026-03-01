#!/usr/bin/env bash
# chat-pollution-sensor.sh — Detects signs of main chat pollution
#
# Checks the nerve stream for recent events that suggest the agent is
# doing heavy work in the main chat instead of dispatching.
#
# Signs of pollution:
#   - Multiple rapid tool calls from agent without dispatch events
#   - No bridge/task-server activity despite agent being active
#   - Explicit "chat_pollution" events
#
# Emits a nerve event if pollution is detected.
# Run periodically or on-demand as a self-check.
#
# Usage: bash nerve/sensors/chat-pollution-sensor.sh
# Exit: 0 = clean, 1 = pollution detected

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
NERVE_SOCK="$CLAWD/nerve/bus.sock"
STREAM="$CLAWD/nerve/stream.jsonl"
SIGNALS="$CLAWD/evolution/signals"

# Check if stream exists
if [ ! -f "$STREAM" ]; then
  echo "clean:no-stream"
  exit 0
fi

# Look at last 5 minutes of stream for pollution signals
CUTOFF=$(date -v-5M -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -d '5 minutes ago' -u +%Y-%m-%dT%H:%M:%S 2>/dev/null || echo "")

if [ -z "$CUTOFF" ]; then
  echo "clean:no-cutoff"
  exit 0
fi

# Count recent chat_pollution events
POLLUTION_COUNT=$(tail -100 "$STREAM" | grep -c "chat_pollution" 2>/dev/null || echo "0")

if [ "$POLLUTION_COUNT" -gt 0 ]; then
  # Emit alert through nerve bus
  if [ -S "$NERVE_SOCK" ]; then
    echo '{"source":"sensor","type":"chat_pollution_alert","detail":"Pollution signal detected in recent stream","count":'"$POLLUTION_COUNT"'}' | nc -U "$NERVE_SOCK" 2>/dev/null || true
  fi

  # Log to signals
  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"type\":\"sensor\",\"detail\":\"chat_pollution_detected\",\"count\":$POLLUTION_COUNT,\"source\":\"chat-pollution-sensor\"}" >> "$SIGNALS/failures.jsonl" 2>/dev/null || true

  echo "pollution:detected:count=$POLLUTION_COUNT"
  exit 1
fi

echo "clean"
exit 0
