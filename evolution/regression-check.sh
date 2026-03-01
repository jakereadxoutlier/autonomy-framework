#!/bin/bash
# Regression check — runs all evolution/nerve scripts with --check, logs pass/fail
set -uo pipefail

CLAWD="${AGENT_HOME:-$HOME/autonomy}"
SIGNALS="${CLAWD}/evolution/signals"
RESULTS="${SIGNALS}/regression-results.json"
FAILURES="${SIGNALS}/failures.jsonl"
PREV_RESULTS=""

mkdir -p "$SIGNALS"

# Load previous results for regression detection
if [[ -f "$RESULTS" ]]; then
  PREV_RESULTS=$(cat "$RESULTS")
fi

json="{"
first=true

run_check() {
  local script="$1"
  local label="$2"
  local output
  local status="pass"

  if output=$(timeout 10 node "$script" --check 2>&1); then
    status="pass"
  else
    status="fail"
  fi

  # Check for regression (was passing, now failing)
  if [[ "$status" == "fail" && -n "$PREV_RESULTS" ]]; then
    prev_status=$(echo "$PREV_RESULTS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d['$label']||'unknown')}catch{console.log('unknown')}" 2>/dev/null || echo "unknown")
    if [[ "$prev_status" == "pass" ]]; then
      echo "{\"type\":\"regression\",\"script\":\"$label\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"output\":\"$(echo "$output" | head -3 | tr '\n' ' ' | sed 's/"/\\"/g')\"}" >> "$FAILURES"
      echo "REGRESSION: $label (was pass, now fail)"
    fi
  fi

  if [[ "$first" == "true" ]]; then
    first=false
  else
    json+=","
  fi
  json+="\"$label\":\"$status\""
  echo "  $label: $status"
}

echo "Running regression checks..."

# Evolution scripts
for script in "$CLAWD"/evolution/*.js; do
  [[ -f "$script" ]] || continue
  label="evolution/$(basename "$script")"
  run_check "$script" "$label"
done

# Nerve scripts
for script in "$CLAWD"/nerve/*.js; do
  [[ -f "$script" ]] || continue
  label="nerve/$(basename "$script")"
  run_check "$script" "$label"
done

# Garden tender
if [[ -f "$CLAWD/garden/garden-tender.js" ]]; then
  run_check "$CLAWD/garden/garden-tender.js" "garden/garden-tender.js"
fi

json+=",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
echo "$json" > "$RESULTS"
echo "Results written to $RESULTS"
