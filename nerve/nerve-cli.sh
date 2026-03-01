#!/bin/bash
# nerve-cli.sh — CLI for interacting with the nerve daemon
#
# Usage:
#   ./nerve-cli.sh status                              Show daemon status
#   ./nerve-cli.sh emit '{"source":"test","msg":"hi"}' Send event to bus
#   ./nerve-cli.sh tail                                Tail the event stream
#   ./nerve-cli.sh tail 50                             Tail last 50 events
#   ./nerve-cli.sh schedule "check barley" "2026-02-28T10:00:00Z" ["reason"]
#   ./nerve-cli.sh stream                              Live stream events (follow mode)
#   ./nerve-cli.sh rules                               Show attention rules
#   ./nerve-cli.sh test '{"source":"email","from":"x@tectonicbid.com"}'  Test classification

NERVE_DIR="$(cd "$(dirname "$0")" && pwd)"
BUS_SOCK="$NERVE_DIR/bus.sock"
STREAM_LOG="$NERVE_DIR/stream.jsonl"
AWARENESS_FILE="$NERVE_DIR/awareness.json"
ATTENTION_FILE="$NERVE_DIR/attention.json"
NERVE_LOG="$NERVE_DIR/nerve.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

case "${1:-help}" in

  status)
    echo -e "${BLUE}═══ Nerve Daemon Status ═══${NC}"
    echo ""

    # Check if bus.sock exists and daemon is running
    if [ -S "$BUS_SOCK" ]; then
      echo -e "  Socket:  ${GREEN}●${NC} $BUS_SOCK"
    else
      echo -e "  Socket:  ${RED}●${NC} not found"
    fi

    # Check PID from awareness.json
    if [ -f "$AWARENESS_FILE" ]; then
      PID=$(python3 -c "import json; d=json.load(open('$AWARENESS_FILE')); print(d.get('daemon_status',{}).get('pid',''))" 2>/dev/null)
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo -e "  Daemon:  ${GREEN}●${NC} running (PID $PID)"
      else
        echo -e "  Daemon:  ${RED}●${NC} not running"
      fi

      STARTED=$(python3 -c "import json; d=json.load(open('$AWARENESS_FILE')); print(d.get('daemon_status',{}).get('started','unknown'))" 2>/dev/null)
      echo "  Started: $STARTED"

      EPM=$(python3 -c "import json; d=json.load(open('$AWARENESS_FILE')); print(d.get('daemon_status',{}).get('events_this_minute',0))" 2>/dev/null)
      P1=$(python3 -c "import json; d=json.load(open('$AWARENESS_FILE')); print(d.get('daemon_status',{}).get('p1_batch_size',0))" 2>/dev/null)
      P2=$(python3 -c "import json; d=json.load(open('$AWARENESS_FILE')); print(d.get('daemon_status',{}).get('p2_batch_size',0))" 2>/dev/null)
      echo "  Events/min: $EPM | P1 batch: $P1 | P2 batch: $P2"
    fi

    echo ""

    # Stream stats
    if [ -f "$STREAM_LOG" ]; then
      TOTAL=$(wc -l < "$STREAM_LOG" | tr -d ' ')
      echo "  Stream:  $TOTAL total events in stream.jsonl"
      LAST=$(tail -1 "$STREAM_LOG" 2>/dev/null | python3 -c "import json,sys; e=json.load(sys.stdin); print(f'  Last:    [{e.get(\"_nerve\",{}).get(\"received\",\"?\")}] P{e.get(\"_nerve\",{}).get(\"priority\",\"?\")} {e.get(\"source\",\"?\")} {e.get(\"type\",e.get(\"msg\",\"\"))}')" 2>/dev/null)
      [ -n "$LAST" ] && echo "$LAST"
    else
      echo "  Stream:  no events yet"
    fi

    echo ""

    # Self-schedule
    if [ -f "$AWARENESS_FILE" ]; then
      SCHED=$(python3 -c "
import json
d = json.load(open('$AWARENESS_FILE'))
ss = d.get('self_schedule', [])
if not ss:
    print('  (none)')
else:
    for s in ss:
        print(f'  • {s[\"check\"]} → {s[\"next\"]}')
" 2>/dev/null)
      echo -e "  ${YELLOW}Self-Schedule:${NC}"
      echo "$SCHED"
    fi

    echo ""

    # Webhook sensor
    if curl -s http://127.0.0.1:7777/health >/dev/null 2>&1; then
      echo -e "  Webhook: ${GREEN}●${NC} listening on :7777"
    else
      echo -e "  Webhook: ${RED}●${NC} not running"
    fi

    echo ""
    ;;

  emit)
    if [ -z "$2" ]; then
      echo "Usage: $0 emit '{\"source\":\"test\",\"msg\":\"hello\"}'"
      exit 1
    fi
    if [ ! -S "$BUS_SOCK" ]; then
      echo -e "${RED}Error: bus.sock not found. Is the daemon running?${NC}"
      exit 1
    fi
    # Send via socat or nc
    if command -v socat &>/dev/null; then
      echo "$2" | socat - UNIX-CONNECT:"$BUS_SOCK"
    else
      echo "$2" | nc -U "$BUS_SOCK"
    fi
    echo -e "${GREEN}Event sent${NC}"
    ;;

  tail)
    N="${2:-20}"
    if [ ! -f "$STREAM_LOG" ]; then
      echo "No events yet."
      exit 0
    fi
    tail -n "$N" "$STREAM_LOG" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        nerve = e.get('_nerve', {})
        p = nerve.get('priority', '?')
        t = nerve.get('received', '?')
        src = e.get('source', '?')
        typ = e.get('type', e.get('msg', e.get('path', '')))
        reason = nerve.get('reason', '')
        print(f'[{t}] P{p} {src:>12}: {typ}  ({reason})')
    except:
        print(line[:120])
"
    ;;

  stream)
    echo "Streaming events (Ctrl+C to stop)..."
    tail -f "$STREAM_LOG" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        nerve = e.get('_nerve', {})
        p = nerve.get('priority', '?')
        src = e.get('source', '?')
        typ = e.get('type', e.get('msg', e.get('path', '')))
        print(f'P{p} {src}: {typ}')
    except:
        print(line[:120])
"
    ;;

  schedule)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: $0 schedule \"check barley\" \"2026-02-28T10:00:00Z\" [\"reason\"]"
      exit 1
    fi
    CHECK="$2"
    NEXT="$3"
    REASON="${4:-manually scheduled}"
    python3 -c "
import json
f = '$AWARENESS_FILE'
d = json.load(open(f))
if 'self_schedule' not in d: d['self_schedule'] = []
d['self_schedule'].append({
    'check': '''$CHECK''',
    'next': '$NEXT',
    'reason': '''$REASON''',
    'recur': None
})
json.dump(d, open(f, 'w'), indent=2)
print(f'Scheduled: \"{CHECK}\" at {NEXT}')
"
    ;;

  rules)
    echo -e "${BLUE}═══ Attention Rules ═══${NC}"
    python3 -c "
import json
rules = json.load(open('$ATTENTION_FILE'))['rules']
for r in rules:
    p = r['priority']
    colors = {0: '\033[0;31m', 1: '\033[0;33m', 2: '\033[0;34m', 3: '\033[0;90m', 4: '\033[0;90m'}
    c = colors.get(p, '')
    nc = '\033[0m'
    match_str = ' '.join(f'{k}={v}' for k,v in r['match'].items()) or '(catch-all)'
    print(f'{c}  P{p}{nc}  {match_str:50s} {r.get(\"reason\",\"\")}')
"
    ;;

  log)
    N="${2:-50}"
    tail -n "$N" "$NERVE_LOG"
    ;;

  help|*)
    echo -e "${BLUE}nerve-cli${NC} — Nerve daemon command line"
    echo ""
    echo "  status                              Show daemon status"
    echo "  emit '{\"source\":\"test\",...}'         Send event to bus"
    echo "  tail [N]                            Show last N events (default 20)"
    echo "  stream                              Live-follow event stream"
    echo "  schedule \"desc\" \"ISO-time\" [reason]  Add self-schedule entry"
    echo "  rules                               Show attention rules"
    echo "  log [N]                             Show last N log lines"
    echo ""
    ;;
esac
