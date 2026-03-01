#!/bin/bash
# Evolution Cycle — runs all 4 scripts in sequence
# Usage: bash evolution/run-cycle.sh
# Or:    ./evolution/run-cycle.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

echo "=== Evolution Cycle $(date) ==="
echo ""

echo "── Gap Processor ──────────────────────────"
node "$DIR/gap-processor.js"
echo ""

echo "── Validator ──────────────────────────────"
node "$DIR/validator.js"
echo ""

echo "── Garden Tender ──────────────────────────"
node "$ROOT/garden/garden-tender.js"
echo ""

echo "── Dashboard ──────────────────────────────"
node "$DIR/dashboard.js"
echo ""

echo "=== Cycle complete $(date) ==="
