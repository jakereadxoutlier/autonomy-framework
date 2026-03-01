#!/bin/bash
# install.sh — Install the nerve daemon as a macOS LaunchAgent
# Uses pure Node.js — no external dependencies.
set -e

NERVE_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
NODE="$(which node 2>/dev/null)"
UID_NUM=$(id -u)

echo "═══ Nerve Daemon Installer ═══"
echo ""

# ─── Check Node ──────────────────────────────────────────────
if [ ! -x "$NODE" ]; then
  echo "ERROR: Node.js not found at $NODE"
  exit 1
fi
echo "  ✓ Node.js $($NODE --version)"

# ─── Create Data Directories ────────────────────────────────
mkdir -p "$NERVE_DIR/events"
mkdir -p "$NERVE_DIR/logs"
touch "$NERVE_DIR/stream.jsonl"
echo "  ✓ Data directories"

# ─── Kill any rogue daemon processes ─────────────────────────
echo ""
echo "Stopping any running nerve processes..."
pkill -f "node.*nerve-daemon.js" 2>/dev/null || true
pkill -f "node.*nerve/daemon.js" 2>/dev/null || true
sleep 1

# ─── Remove stale socket ────────────────────────────────────
rm -f "$NERVE_DIR/bus.sock"
rm -f "$NERVE_DIR/nerve.pid"
echo "  ✓ Cleaned stale socket and PID file"

# ─── Unload ALL existing nerve agents ────────────────────────
echo ""
echo "Unloading old LaunchAgents..."
for label in ai.autonomy.nerve ai.autonomy.nerve.fswatch ai.nerve.daemon ai.nerve.sensor.fswatch ai.nerve.sensor.webhook; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
done
# Also remove old plist files that might conflict
rm -f "$LAUNCH_AGENTS/ai.autonomy.nerve.fswatch.plist"
rm -f "$LAUNCH_AGENTS/ai.nerve.daemon.plist"
rm -f "$LAUNCH_AGENTS/ai.nerve.sensor.fswatch.plist"
rm -f "$LAUNCH_AGENTS/ai.nerve.sensor.webhook.plist"
sleep 2
echo "  ✓ Old agents unloaded and cleaned"

# ─── Write plist ─────────────────────────────────────────────
echo ""
echo "Writing LaunchAgent plist..."
mkdir -p "$LAUNCH_AGENTS"

# Copy the canonical plist from the nerve directory
cp "$NERVE_DIR/ai.autonomy.nerve.plist" "$LAUNCH_AGENTS/ai.autonomy.nerve.plist"
echo "  ✓ ai.autonomy.nerve.plist installed"

# ─── Load ────────────────────────────────────────────────────
echo ""
echo "Loading LaunchAgent..."
launchctl bootstrap "gui/$UID_NUM" "$LAUNCH_AGENTS/ai.autonomy.nerve.plist"
echo "  ✓ ai.autonomy.nerve loaded"

# ─── Verify ──────────────────────────────────────────────────
echo ""
echo "Verifying..."
sleep 3

# Check bus.sock
if [ -S "$NERVE_DIR/bus.sock" ]; then
  echo "  ✓ bus.sock exists and is a socket"
else
  echo "  ✗ bus.sock not found — checking logs..."
  echo "    stderr: $(tail -5 "$NERVE_DIR/logs/daemon-stderr.log" 2>/dev/null || echo 'empty')"
  echo "    nerve.log: $(tail -3 "$NERVE_DIR/nerve.log" 2>/dev/null || echo 'empty')"
  exit 1
fi

# Check PID file
if [ -f "$NERVE_DIR/nerve.pid" ]; then
  PID=$(cat "$NERVE_DIR/nerve.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "  ✓ Daemon running (PID $PID)"
  else
    echo "  ✗ PID file exists but process $PID is dead"
    exit 1
  fi
else
  echo "  ⏳ No PID file yet (daemon may still be starting)"
fi

# Send test event
echo '{"source":"install","type":"verify","msg":"nerve installed successfully"}' | $NODE -e "
const net = require('net');
const c = net.createConnection('$NERVE_DIR/bus.sock', () => {
  let data = '';
  process.stdin.on('data', d => data += d);
  process.stdin.on('end', () => { c.write(data + '\n'); c.end(); });
});
c.on('error', e => { console.error('send failed:', e.message); process.exit(1); });
"
echo "  ✓ Test event sent and accepted"

# Final status
echo ""
echo "═══ Installation Complete ═══"
echo ""
echo "  Status:    launchctl print gui/$UID_NUM/ai.autonomy.nerve"
echo "  Logs:      tail -f $NERVE_DIR/nerve.log"
echo "  Stdout:    tail -f $NERVE_DIR/logs/daemon-stdout.log"
echo "  Stderr:    tail -f $NERVE_DIR/logs/daemon-stderr.log"
echo "  Stream:    tail -f $NERVE_DIR/stream.jsonl"
echo "  Socket:    $NERVE_DIR/bus.sock"
echo ""
echo "  Uninstall:"
echo "    launchctl bootout gui/$UID_NUM/ai.autonomy.nerve"
echo ""
