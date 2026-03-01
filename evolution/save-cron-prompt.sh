#!/bin/bash
# Save current evolution cron prompt to history
DIR="$(dirname "$0")/cron-prompt-history"
mkdir -p "$DIR"
TIMESTAMP=$(date +%Y-%m-%dT%H%M)
OUTFILE="$DIR/$TIMESTAMP.md"

# Read cron config and extract the evolution prompt
CRON_FILE="${AGENT_HOME:-$HOME/autonomy}/evolution/cron.json"
if [ -f "$CRON_FILE" ]; then
  cp "$CRON_FILE" "$OUTFILE"
  echo "Saved cron prompt to $OUTFILE"
else
  echo "No cron config found at $CRON_FILE"
  exit 1
fi
