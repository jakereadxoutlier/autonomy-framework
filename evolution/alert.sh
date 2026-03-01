#!/usr/bin/env bash
# alert.sh — Write urgent alerts for the evolution engine to deliver
# Usage: ./alert.sh "Bridge daemon is down!"

set -euo pipefail

MSG="${1:?Usage: alert.sh \"message\"}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ALERTS_MD="${AGENT_HOME:-$HOME/autonomy}/evolution/ALERTS.md"
ALERTS_JSONL="${AGENT_HOME:-$HOME/autonomy}/evolution/signals/urgent-alerts.jsonl"

# Prepend to ALERTS.md
EXISTING=""
[ -f "$ALERTS_MD" ] && EXISTING="$(cat "$ALERTS_MD")"
printf "## %s\n%s\n\n%s" "$TS" "$MSG" "$EXISTING" > "$ALERTS_MD"

# Append to urgent-alerts.jsonl (for cron tick to deliver via message tool)
printf '{"ts":"%s","msg":"%s","delivered":false}\n' "$TS" "$MSG" >> "$ALERTS_JSONL"

echo "Alert logged: $MSG"
