#!/usr/bin/env bash
# cron-health.sh — Monitor health of all crons (openclaw + launchd) (openclaw integration is optional)
#
# Checks:
#   1. openclaw crons list — parses output, checks last run + exit status
#   2. LaunchAgent daemons — checks if bridge, nerve, gateway are alive
#   3. Flags anything overdue (>2x interval) or last-exited non-zero
#   4. Writes full state to signals/cron-health.json
#   5. Appends unhealthy entries to signals/failures.jsonl (severity 3)
#
# Usage: bash evolution/cron-health.sh
# Exit codes:
#   0 = all healthy (or report written successfully)
#   1 = setup error (missing dirs, etc)

set -euo pipefail

CLAWD="${AGENT_HOME:-${AGENT_HOME:-$HOME/autonomy}}"
SIGNALS_DIR="$CLAWD/evolution/signals"
HEALTH_FILE="$SIGNALS_DIR/cron-health.json"
FAILURES_FILE="$SIGNALS_DIR/failures.jsonl"
OPENCLAW_BIN=$(which openclaw 2>/dev/null || echo "")

mkdir -p "$SIGNALS_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

NOW_EPOCH=$(date +%s)
NOW_ISO=$(timestamp)
UNHEALTHY_COUNT=0
CRON_RESULTS="[]"

# Helper: append a JSON object to CRON_RESULTS array
# Uses a temp file approach since bash can't do JSON natively
RESULTS_TMP=$(mktemp /tmp/cron-health-XXXXXX.json)
echo "[]" > "$RESULTS_TMP"

add_result() {
  local name="$1" source="$2" schedule="$3" last_run="$4" exit_code="$5" healthy="$6" reason="$7"

  # Build JSON entry (avoiding jq dependency — use printf)
  local entry
  entry=$(printf '{"name":"%s","source":"%s","schedule":"%s","last_run":"%s","exit_code":%s,"healthy":%s,"reason":"%s","checked_at":"%s"}' \
    "$name" "$source" "$schedule" "$last_run" "$exit_code" "$healthy" "$reason" "$NOW_ISO")

  # Append to results file
  local current
  current=$(cat "$RESULTS_TMP")
  if [ "$current" = "[]" ]; then
    echo "[$entry]" > "$RESULTS_TMP"
  else
    # Remove trailing ] and append
    echo "${current%]}, $entry]" > "$RESULTS_TMP"
  fi

  # If unhealthy, also append to failures.jsonl
  if [ "$healthy" = "false" ]; then
    UNHEALTHY_COUNT=$((UNHEALTHY_COUNT + 1))
    local failure
    failure=$(printf '{"ts":"%s","type":"cron_unhealthy","detail":"Cron %s (%s) is unhealthy: %s","severity":3,"source":"cron-health-monitor"}' \
      "$NOW_ISO" "$name" "$source" "$reason")
    echo "$failure" >> "$FAILURES_FILE"
  fi
}

# ──────────────────────────────────────────────────────────────────
# Section 1: OpenClaw managed crons
# ──────────────────────────────────────────────────────────────────

parse_openclaw_crons() {
  if [ -z "$OPENCLAW_BIN" ]; then
    echo "  ⚠ openclaw CLI not found, skipping openclaw crons" >&2
    add_result "openclaw-cli" "system" "n/a" "n/a" "null" "false" "openclaw CLI not in PATH"
    return
  fi

  # Try JSON output first
  local raw_output=""
  local got_json=false

  if raw_output=$("$OPENCLAW_BIN" crons list --json 2>/dev/null); then
    # Check if it's actually JSON
    if echo "$raw_output" | head -1 | grep -q '^\['; then
      got_json=true
    fi
  fi

  if [ "$got_json" = true ]; then
    parse_openclaw_json "$raw_output"
  else
    # Fall back to text output
    raw_output=$("$OPENCLAW_BIN" crons list 2>/dev/null) || true
    if [ -n "$raw_output" ]; then
      parse_openclaw_text "$raw_output"
    else
      echo "  ⚠ openclaw crons list returned no output" >&2
      add_result "openclaw-crons" "openclaw" "n/a" "n/a" "null" "false" "crons list returned empty output"
    fi
  fi
}

parse_openclaw_json() {
  local json="$1"
  # Parse JSON array of cron objects
  # Expected fields: name, schedule, lastRun (ISO), lastExitCode, interval (seconds)
  # We use grep/sed since jq might not be available

  # Try jq first
  if command -v jq &>/dev/null; then
    local count
    count=$(echo "$json" | jq 'length')

    for i in $(seq 0 $((count - 1))); do
      local name schedule last_run exit_code interval_sec
      name=$(echo "$json" | jq -r ".[$i].name // .[$i].id // \"unknown-$i\"")
      schedule=$(echo "$json" | jq -r ".[$i].schedule // \"unknown\"")
      last_run=$(echo "$json" | jq -r ".[$i].lastRun // .[$i].last_run // \"never\"")
      exit_code=$(echo "$json" | jq -r ".[$i].lastExitCode // .[$i].exit_code // 0")
      interval_sec=$(echo "$json" | jq -r ".[$i].interval // 0")

      # If no interval provided, estimate from cron schedule
      if [ "$interval_sec" = "0" ] || [ "$interval_sec" = "null" ]; then
        interval_sec=$(estimate_interval "$schedule")
      fi

      check_cron_health "$name" "openclaw" "$schedule" "$last_run" "$exit_code" "$interval_sec"
    done
  else
    # No jq — do basic grep parsing
    echo "  ⚠ jq not available, doing basic JSON parse" >&2
    # Extract name/lastRun pairs with grep
    echo "$json" | grep -oE '"name"\s*:\s*"[^"]*"' | while read -r line; do
      local name
      name=$(echo "$line" | sed 's/.*"name"\s*:\s*"\([^"]*\)".*/\1/')
      add_result "$name" "openclaw" "unknown" "unknown" "null" "true" "parsed without jq - limited data"
    done
  fi
}

parse_openclaw_text() {
  local text="$1"

  # Common CLI table formats:
  # NAME          SCHEDULE       LAST RUN              STATUS
  # daily-tik...  0 15 * * *     2026-02-28 07:00:00   OK
  #
  # Or pipe-separated:
  # name | schedule | last_run | exit_code
  #
  # We'll try to detect the format and parse accordingly

  # Skip header line(s), parse data rows
  local line_num=0
  local header_detected=false
  local separator_type=""

  while IFS= read -r line; do
    line_num=$((line_num + 1))

    # Skip empty lines
    [ -z "$(echo "$line" | tr -d '[:space:]')" ] && continue

    # Detect header row (contains "NAME" or "name")
    if echo "$line" | grep -qi "name.*schedule\|name.*cron\|id.*schedule"; then
      header_detected=true
      # Detect separator type
      if echo "$line" | grep -q '|'; then
        separator_type="pipe"
      else
        separator_type="spaces"
      fi
      continue
    fi

    # Skip separator lines (----, ====, etc)
    if echo "$line" | grep -qE '^[-=|+ ]+$'; then
      continue
    fi

    # If no header yet and we're past line 3, treat all as data
    if [ "$header_detected" = false ] && [ "$line_num" -gt 3 ]; then
      header_detected=true
      separator_type="spaces"
    fi

    [ "$header_detected" = false ] && continue

    local name="" schedule="" last_run="" exit_code="0"

    if [ "$separator_type" = "pipe" ]; then
      # Pipe-separated
      name=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $1); print $1}')
      schedule=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')
      last_run=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $3); print $3}')
      exit_code=$(echo "$line" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $4); print $4}')
    else
      # Space-separated — first field is name, rest is harder
      name=$(echo "$line" | awk '{print $1}')
      # Try to extract schedule (5 cron fields) and remaining
      schedule=$(echo "$line" | awk '{print $2, $3, $4, $5, $6}')
      last_run=$(echo "$line" | awk '{for(i=7;i<=NF-1;i++) printf $i " "; print ""}' | xargs)
      # Last field might be status/exit code
      local last_field
      last_field=$(echo "$line" | awk '{print $NF}')
      if echo "$last_field" | grep -qE '^[0-9]+$'; then
        exit_code="$last_field"
      elif echo "$last_field" | grep -qi 'ok\|success\|running'; then
        exit_code="0"
      elif echo "$last_field" | grep -qi 'fail\|error\|dead'; then
        exit_code="1"
      fi
    fi

    [ -z "$name" ] && continue

    local interval_sec
    interval_sec=$(estimate_interval "$schedule")

    check_cron_health "$name" "openclaw" "$schedule" "$last_run" "${exit_code:-0}" "$interval_sec"

  done <<< "$text"
}

# Estimate interval in seconds from a cron schedule string
estimate_interval() {
  local schedule="$1"

  # Handle common patterns
  case "$schedule" in
    "*/5 "*|*"every 5 min"*)  echo 300 ;;
    "*/10 "*|*"every 10 min"*) echo 600 ;;
    "*/15 "*|*"every 15 min"*) echo 900 ;;
    "*/30 "*|*"every 30 min"*) echo 1800 ;;
    "0 * "*|*"hourly"*)       echo 3600 ;;
    "0 */2 "*|*"every 2 h"*)  echo 7200 ;;
    "0 */6 "*|*"every 6 h"*)  echo 21600 ;;
    "0 0 "*|*"daily"*|"0 "[0-9]" * * *") echo 86400 ;;
    "0 "[0-9]" * * 1"|*"weekly"*) echo 604800 ;;
    *)
      # Default: assume daily if we can't parse
      echo 86400
      ;;
  esac
}

# Check if a cron is healthy based on last_run and exit_code
check_cron_health() {
  local name="$1" source="$2" schedule="$3" last_run="$4" exit_code="$5" interval_sec="$6"

  local healthy="true"
  local reason="ok"

  # Check exit code
  if [ "$exit_code" != "0" ] && [ "$exit_code" != "null" ] && [ -n "$exit_code" ]; then
    healthy="false"
    reason="last exit code was $exit_code"
  fi

  # Check if overdue (last_run > 2x interval)
  if [ "$last_run" != "never" ] && [ "$last_run" != "n/a" ] && [ "$last_run" != "unknown" ] && [ -n "$last_run" ]; then
    local last_run_epoch
    # Try to parse the date (handle both ISO and human formats)
    last_run_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_run%%[.Z]*}" +%s 2>/dev/null) || \
    last_run_epoch=$(date -j -f "%Y-%m-%d %H:%M:%S" "$last_run" +%s 2>/dev/null) || \
    last_run_epoch=$(date -j -f "%Y-%m-%d %H:%M" "$last_run" +%s 2>/dev/null) || \
    last_run_epoch=""

    if [ -n "$last_run_epoch" ] && [ "$interval_sec" -gt 0 ]; then
      local age=$((NOW_EPOCH - last_run_epoch))
      local threshold=$((interval_sec * 2))

      if [ "$age" -gt "$threshold" ]; then
        local age_human
        if [ "$age" -gt 86400 ]; then
          age_human="$((age / 86400))d ago"
        elif [ "$age" -gt 3600 ]; then
          age_human="$((age / 3600))h ago"
        else
          age_human="$((age / 60))m ago"
        fi
        healthy="false"
        if [ "$reason" = "ok" ]; then
          reason="overdue: last ran ${age_human}, expected every $((interval_sec / 60))m"
        else
          reason="${reason}; also overdue: last ran ${age_human}"
        fi
      fi
    fi
  elif [ "$last_run" = "never" ]; then
    healthy="false"
    reason="has never run"
  fi

  add_result "$name" "$source" "$schedule" "$last_run" "${exit_code:-null}" "$healthy" "$reason"
}

# ──────────────────────────────────────────────────────────────────
# Section 2: LaunchAgent daemons (bridge, nerve, gateway)
# ──────────────────────────────────────────────────────────────────

check_launchd_daemons() {
  # Key daemons we expect to be running
  local -a daemons=(
    "bridge-daemon:node.*bridge-daemon:ai.autonomy.bridge:continuous"
    "nerve-daemon:node.*nerve.*daemon:ai.autonomy.nerve:continuous"
    "gateway:openclaw.*gateway:ai.autonomy.gateway:continuous"
    "health-check:halo-health-check:n/a:300"
  )

  for entry in "${daemons[@]}"; do
    IFS=':' read -r name pattern label interval <<< "$entry"

    local pid=""
    pid=$(pgrep -f "$pattern" 2>/dev/null | head -1) || true

    if [ -n "$pid" ]; then
      add_result "$name" "launchd" "$label" "$NOW_ISO" "0" "true" "running (PID $pid)"
    else
      # Check if the LaunchAgent exists at all
      if [ -f "$HOME/Library/LaunchAgents/${label}.plist" ] 2>/dev/null; then
        add_result "$name" "launchd" "$label" "unknown" "null" "false" "process not running but plist exists"
      else
        add_result "$name" "launchd" "$label" "n/a" "null" "false" "process not running, no plist found"
      fi
    fi
  done
}

# ──────────────────────────────────────────────────────────────────
# Section 3: Check log-based crons (crontab, scripts with log files)
# ──────────────────────────────────────────────────────────────────

check_log_based_crons() {
  # Check known cron log files for recent activity
  local -a log_checks=(
    "personal-inbox:$CLAWD/scripts/personal-inbox.log:1800"
    "weekly-report:$CLAWD/scripts/weekly-report.log:604800"
  )

  for entry in "${log_checks[@]}"; do
    IFS=':' read -r name logfile interval <<< "$entry"

    if [ ! -f "$logfile" ]; then
      add_result "$name" "log-check" "n/a" "never" "null" "false" "log file not found: $logfile"
      continue
    fi

    # Get last modification time of the log
    local last_mod
    last_mod=$(stat -f %m "$logfile" 2>/dev/null) || last_mod=0

    if [ "$last_mod" -eq 0 ]; then
      add_result "$name" "log-check" "n/a" "unknown" "null" "false" "could not stat log file"
      continue
    fi

    local age=$((NOW_EPOCH - last_mod))
    local last_mod_iso
    last_mod_iso=$(date -r "$last_mod" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null) || last_mod_iso="unknown"

    # Check last line for error indicators
    local last_line
    last_line=$(tail -1 "$logfile" 2>/dev/null) || last_line=""
    local exit_code="0"
    if echo "$last_line" | grep -qi "error\|fail\|crash\|exception\|SIGKILL"; then
      exit_code="1"
    fi

    check_cron_health "$name" "log-check" "varies" "$last_mod_iso" "$exit_code" "$interval"
  done
}

# ──────────────────────────────────────────────────────────────────
# Main execution
# ──────────────────────────────────────────────────────────────────

echo "=== Cron Health Monitor $(date) ==="
echo ""

echo "── OpenClaw Managed Crons ──────────────────"
parse_openclaw_crons
echo ""

echo "── LaunchAgent Daemons ─────────────────────"
check_launchd_daemons
echo ""

echo "── Log-Based Crons ─────────────────────────"
check_log_based_crons
echo ""

# ──────────────────────────────────────────────────────────────────
# Write final report
# ──────────────────────────────────────────────────────────────────

RESULTS=$(cat "$RESULTS_TMP")
rm -f "$RESULTS_TMP"

# Count totals
TOTAL=$(echo "$RESULTS" | grep -o '"name"' | wc -l | tr -d ' ')
HEALTHY=$(echo "$RESULTS" | grep -o '"healthy":true' | wc -l | tr -d ' ')

# Build summary JSON
cat > "$HEALTH_FILE" <<ENDJSON
{
  "checked_at": "$NOW_ISO",
  "total_crons": $TOTAL,
  "healthy": $HEALTHY,
  "unhealthy": $UNHEALTHY_COUNT,
  "all_healthy": $([ "$UNHEALTHY_COUNT" -eq 0 ] && echo "true" || echo "false"),
  "crons": $RESULTS
}
ENDJSON

echo "── Summary ───────────────────────────────────"
echo "  Total:     $TOTAL"
echo "  Healthy:   $HEALTHY"
echo "  Unhealthy: $UNHEALTHY_COUNT"
echo ""
echo "  Report: $HEALTH_FILE"

if [ "$UNHEALTHY_COUNT" -gt 0 ]; then
  echo "  ⚠ $UNHEALTHY_COUNT unhealthy cron(s) — see $FAILURES_FILE"
fi

echo ""
echo "=== Done $(date) ==="
