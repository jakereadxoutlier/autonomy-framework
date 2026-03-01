#!/bin/bash
# Validate bridge responses — check that claimed deliverables actually exist
RESPONSES=${AGENT_HOME:-$HOME/autonomy}/evolution/responses
LOG=${AGENT_HOME:-$HOME/autonomy}/evolution/signals/validation-log.jsonl

for resp in "$RESPONSES"/*.md; do
  [ -f "$resp" ] || continue
  base=$(basename "$resp")
  
  # Extract file paths mentioned in response (look for ${AGENT_HOME:-$HOME/autonomy}/ or relative paths)
  paths=$(grep -oE '(${AGENT_HOME:-$HOME/autonomy}|evolution|nerve|garden)/[a-zA-Z0-9_./-]+\.(js|sh|html|json|md)' "$resp" | sort -u)
  
  missing=()
  for p in $paths; do
    # Resolve ~ 
    resolved="${p/#\~/$HOME}"
    # Try relative to autonomy
    if [ ! -f "$resolved" ] && [ ! -f "${AGENT_HOME:-$HOME/autonomy}/$resolved" ]; then
      missing+=("$p")
    fi
  done
  
  if [ ${#missing[@]} -gt 0 ]; then
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"response\":\"$base\",\"missing\":[$(printf '\"%s\",' "${missing[@]}" | sed 's/,$//')]}" >> "$LOG"
  fi
done

echo "Validation complete. Check $LOG for issues."
