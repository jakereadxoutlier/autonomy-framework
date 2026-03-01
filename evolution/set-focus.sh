#!/usr/bin/env bash
# Usage: ./set-focus.sh explore
#        ./set-focus.sh deep "artificial-curiosity" 5
SIGNALS="$(dirname "$0")/signals"
FILE="$SIGNALS/focus-mode.json"

MODE="${1:-explore}"
TOPIC="${2:-null}"
TICKS="${3:-0}"

if [ "$MODE" = "explore" ]; then
  TOPIC="null"
  TICKS=0
elif [ "$MODE" = "deep" ] && [ "$TOPIC" = "null" ]; then
  echo "Error: deep mode requires a topic. Usage: $0 deep <topic> [ticks]"
  exit 1
fi

[ "$TICKS" = "0" ] && [ "$MODE" = "deep" ] && TICKS=5
[ "$TOPIC" != "null" ] && TOPIC="\"$TOPIC\""

cat > "$FILE" <<EOF
{
  "mode": "$MODE",
  "deep_focus_topic": $TOPIC,
  "deep_focus_remaining_ticks": $TICKS,
  "description": "explore = one new topic per tick. deep = stay on one topic for N ticks. The evolution engine reads this and adjusts behavior."
}
EOF
echo "Focus set to: $MODE $([ "$MODE" = "deep" ] && echo "on $2 for $TICKS ticks")"
