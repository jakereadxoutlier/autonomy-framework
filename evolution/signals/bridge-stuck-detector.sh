#!/bin/bash
# Detect stuck bridge requests (processing > 15 minutes)
BRIDGE_LOG="${AGENT_HOME:-$HOME/autonomy}/evolution/bridge.log"

if [ ! -f "$BRIDGE_LOG" ]; then
  echo "No bridge.log found"
  exit 0
fi

NOW=$(date +%s)
THRESHOLD=900  # 15 minutes in seconds

# Find lines showing a request started processing
grep -i "processing\|started\|picking up" "$BRIDGE_LOG" | tail -20 | while read -r line; do
  # Extract timestamp (ISO format or similar)
  TS=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
  if [ -z "$TS" ]; then continue; fi
  
  EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$TS" +%s 2>/dev/null || date -d "$TS" +%s 2>/dev/null)
  if [ -z "$EPOCH" ]; then continue; fi
  
  AGE=$((NOW - EPOCH))
  if [ "$AGE" -gt "$THRESHOLD" ]; then
    REQ=$(echo "$line" | grep -oE '[a-zA-Z0-9_-]+\.md' | head -1)
    echo "STUCK: $REQ has been processing for $((AGE / 60)) minutes"
    echo "  Line: $line"
  fi
done

# Check if any request file still has "processing" status
for f in "${AGENT_HOME:-$HOME/autonomy}/evolution/requests/"*.md; do
  [ -f "$f" ] || continue
  if grep -q "Status:.*processing" "$f" 2>/dev/null; then
    MOD=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)
    AGE=$((NOW - MOD))
    if [ "$AGE" -gt "$THRESHOLD" ]; then
      echo "STUCK REQUEST FILE: $(basename "$f") — modified $((AGE / 60))m ago, still 'processing'"
      echo "  Consider changing status to 'pending' to retry, or 'failed' to skip"
    fi
  fi
done
