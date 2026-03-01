#!/bin/bash
# evolve.sh — Master evolution loop
#
# Chains: gap detection → request generation → validation → dashboard
# Run manually or via cron (every 30 min).
#
# Usage: bash evolution/evolve.sh
#        bash evolution/evolve.sh --quiet   (suppress dashboard)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAWD="$(dirname "$SCRIPT_DIR")"
cd "$CLAWD"

QUIET=false
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=true
fi

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [evolve] $1"
}

# ── Step 1: Process gaps → generate requests ─────────────────────────────────
log "Step 1: Processing capability gaps..."
node evolution/gap-processor.js
echo ""

# ── Step 2: Bridge daemon handles pending requests ───────────────────────────
# The bridge daemon (bridge-daemon.js) runs as a LaunchAgent and picks up
# any new request files automatically. We don't spawn it here — just note
# that requests are now queued for processing.
PENDING=$(ls -1 evolution/requests/*.md 2>/dev/null | while read f; do
  grep -l 'Status:\*\* pending' "$f" 2>/dev/null
done | wc -l | tr -d ' ')

if [ "$PENDING" -gt 0 ]; then
  log "Step 2: ${PENDING} request(s) pending for bridge daemon to process."
  log "  (Bridge daemon polls every 10s — requests will be handled automatically.)"
else
  log "Step 2: No pending requests. Bridge daemon idle."
fi
echo ""

# ── Step 3: Validate responses ───────────────────────────────────────────────
log "Step 3: Validating completed responses..."
node evolution/validator.js
echo ""

# ── Step 4: Dashboard report ─────────────────────────────────────────────────
if [ "$QUIET" = false ]; then
  log "Step 4: Running dashboard..."
  echo ""
  node evolution/dashboard.js
else
  log "Step 4: Dashboard suppressed (--quiet mode)."
fi

log "Evolution cycle complete."
