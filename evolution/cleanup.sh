#!/bin/bash
# Disk cleanup for evolution system
set -e
CLAWD="${AGENT_HOME:-$HOME/autonomy}"

echo "=== Evolution Cleanup ==="

# Remove processed bridge responses older than 7 days
echo "Cleaning bridge responses older than 7 days..."
find "$CLAWD/evolution/responses" -name "*.md" -mtime +7 -delete 2>/dev/null && echo "  Done" || echo "  No responses dir"

# Remove processed subagent outputs older than 3 days
echo "Cleaning subagent outputs older than 3 days..."
find "$CLAWD/evolution/signals/subagent-outputs" -type f -mtime +3 -delete 2>/dev/null && echo "  Done" || echo "  No subagent-outputs dir"

# Trim nerve stream.jsonl — keep entries from last 7 days
STREAM="$CLAWD/nerve/stream.jsonl"
if [ -f "$STREAM" ]; then
  CUTOFF=$(date -v-7d +%Y-%m-%d 2>/dev/null || date -d '7 days ago' +%Y-%m-%d)
  TMP=$(mktemp)
  awk -v cutoff="$CUTOFF" '/"ts"/ { if (match($0, /"ts":"([^"]+)"/, a) && a[1] >= cutoff) print; next } { print }' "$STREAM" > "$TMP"
  mv "$TMP" "$STREAM"
  echo "Trimmed nerve stream.jsonl to last 7 days"
else
  echo "No nerve/stream.jsonl found"
fi

# Show disk usage
echo ""
echo "=== Disk Usage ==="
du -sh "$CLAWD" 2>/dev/null
du -sh "$CLAWD"/*/ 2>/dev/null | sort -rh | head -10
