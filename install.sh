#!/bin/bash
# install.sh — Autonomy Framework installer for macOS
#
# Usage:
#   ./install.sh              # installs to ~/autonomy
#   ./install.sh /path/to/dir # installs to specified directory
#
# This script is safe to re-run. It will NOT overwrite existing configs.
set -e

# ─── Configuration ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${1:-$HOME/autonomy}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
UID_NUM=$(id -u)

echo ""
echo "============================================"
echo "  Autonomy Framework Installer"
echo "============================================"
echo ""
echo "  Source:  $SCRIPT_DIR"
echo "  Target:  $INSTALL_DIR"
echo ""

# ─── Step 1: Detect Node.js ──────────────────────────────────
NODE_BIN=$(which node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: Node.js not found in PATH."
  echo "Install it via: brew install node"
  exit 1
fi
NODE_VERSION=$($NODE_BIN --version)
echo "  [ok] Node.js $NODE_VERSION at $NODE_BIN"

# ─── Step 2: Detect Claude CLI ───────────────────────────────
CLAUDE_BIN=$(which claude 2>/dev/null || true)
if [ -z "$CLAUDE_BIN" ]; then
  echo "  [--] Claude CLI not found (optional, needed for bridge)"
else
  echo "  [ok] Claude CLI at $CLAUDE_BIN"
fi

# ─── Step 3: Create directory structure ──────────────────────
echo ""
echo "Creating directory structure..."

# Evolution subsystem directories
mkdir -p "$INSTALL_DIR/evolution/requests"
mkdir -p "$INSTALL_DIR/evolution/responses"
mkdir -p "$INSTALL_DIR/evolution/signals"
mkdir -p "$INSTALL_DIR/evolution/predictions"

# Nerve subsystem directories
mkdir -p "$INSTALL_DIR/nerve/sensors"
mkdir -p "$INSTALL_DIR/nerve/events"

# Garden subsystem directories
mkdir -p "$INSTALL_DIR/garden/seeds"
mkdir -p "$INSTALL_DIR/garden/growing"
mkdir -p "$INSTALL_DIR/garden/mature"
mkdir -p "$INSTALL_DIR/garden/compost"

echo "  [ok] Directory structure created"

# ─── Step 4: Copy config files (safe — no overwrite) ─────────
echo ""
echo "Installing configuration files..."

# Main config
if [ -f "$INSTALL_DIR/config.json" ]; then
  echo "  [--] config.json already exists, skipping"
else
  cp "$SCRIPT_DIR/config.example.json" "$INSTALL_DIR/config.json"
  # Patch in detected paths
  if command -v sed &>/dev/null; then
    sed -i '' "s|\"node_bin\": \"node\"|\"node_bin\": \"$NODE_BIN\"|" "$INSTALL_DIR/config.json"
    sed -i '' "s|\"agent_home\": \"~/autonomy\"|\"agent_home\": \"$INSTALL_DIR\"|" "$INSTALL_DIR/config.json"
    if [ -n "$CLAUDE_BIN" ]; then
      sed -i '' "s|\"claude_bin\": \"claude\"|\"claude_bin\": \"$CLAUDE_BIN\"|" "$INSTALL_DIR/config.json"
    fi
  fi
  echo "  [ok] config.json created with detected paths"
fi

# Attention config
if [ -f "$INSTALL_DIR/nerve/attention.json" ]; then
  echo "  [--] nerve/attention.json already exists, skipping"
else
  cp "$SCRIPT_DIR/examples/attention.example.json" "$INSTALL_DIR/nerve/attention.json"
  echo "  [ok] nerve/attention.json installed"
fi

# Cascades config
if [ -f "$INSTALL_DIR/nerve/cascades.json" ]; then
  echo "  [--] nerve/cascades.json already exists, skipping"
else
  cp "$SCRIPT_DIR/examples/cascades.example.json" "$INSTALL_DIR/nerve/cascades.json"
  echo "  [ok] nerve/cascades.json installed"
fi

# ─── Step 5: Copy daemon scripts ─────────────────────────────
echo ""
echo "Installing daemon scripts..."

# Copy nerve daemon and related scripts
for SCRIPT in nerve-daemon.js daemon.js nerve-cli.sh; do
  if [ -f "$SCRIPT_DIR/nerve/$SCRIPT" ]; then
    cp "$SCRIPT_DIR/nerve/$SCRIPT" "$INSTALL_DIR/nerve/$SCRIPT"
    echo "  [ok] nerve/$SCRIPT"
  fi
done

# Copy sensors
if [ -d "$SCRIPT_DIR/nerve/sensors" ]; then
  cp -r "$SCRIPT_DIR/nerve/sensors/"* "$INSTALL_DIR/nerve/sensors/" 2>/dev/null || true
  echo "  [ok] nerve/sensors/"
fi

# Copy garden tender
if [ -f "$SCRIPT_DIR/garden/garden-tender.js" ]; then
  cp "$SCRIPT_DIR/garden/garden-tender.js" "$INSTALL_DIR/garden/garden-tender.js"
  echo "  [ok] garden/garden-tender.js"
fi

# Copy evolution scripts
if [ -d "$SCRIPT_DIR/evolution" ]; then
  for F in "$SCRIPT_DIR/evolution/"*.js "$SCRIPT_DIR/evolution/"*.sh "$SCRIPT_DIR/evolution/"*.md; do
    [ -f "$F" ] || continue
    BASENAME=$(basename "$F")
    cp "$F" "$INSTALL_DIR/evolution/$BASENAME"
  done
  # Copy subdirectories with scripts (signals, etc.)
  for SUBDIR in signals proposals snapshots; do
    if [ -d "$SCRIPT_DIR/evolution/$SUBDIR" ]; then
      mkdir -p "$INSTALL_DIR/evolution/$SUBDIR"
      for F in "$SCRIPT_DIR/evolution/$SUBDIR/"*.js "$SCRIPT_DIR/evolution/$SUBDIR/"*.sh; do
        [ -f "$F" ] || continue
        cp "$F" "$INSTALL_DIR/evolution/$SUBDIR/$(basename "$F")"
      done
    fi
  done
  echo "  [ok] evolution scripts"
fi

# Make shell scripts executable
find "$INSTALL_DIR" -name "*.sh" -exec chmod +x {} \;

# ─── Step 6: Generate LaunchAgent plists ──────────────────────
echo ""
echo "Generating LaunchAgent plists..."
mkdir -p "$LAUNCH_AGENTS"

# --- Nerve daemon plist ---
NERVE_PLIST="$LAUNCH_AGENTS/ai.autonomy.nerve.plist"
if [ -f "$NERVE_PLIST" ]; then
  echo "  [--] ai.autonomy.nerve.plist already exists, skipping"
else
  cat > "$NERVE_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.autonomy.nerve</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/nerve/nerve-daemon.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/nerve/logs/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/nerve/logs/daemon-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTONOMY_HOME</key>
        <string>$INSTALL_DIR</string>
    </dict>
</dict>
</plist>
PLIST_EOF
  echo "  [ok] ai.autonomy.nerve.plist generated"
fi

# --- Garden tender plist (runs daily) ---
GARDEN_PLIST="$LAUNCH_AGENTS/ai.autonomy.garden.plist"
if [ -f "$GARDEN_PLIST" ]; then
  echo "  [--] ai.autonomy.garden.plist already exists, skipping"
else
  cat > "$GARDEN_PLIST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.autonomy.garden</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$INSTALL_DIR/garden/garden-tender.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>3</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/garden/garden-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/garden/garden-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>AUTONOMY_HOME</key>
        <string>$INSTALL_DIR</string>
    </dict>
</dict>
</plist>
PLIST_EOF
  echo "  [ok] ai.autonomy.garden.plist generated"
fi

# ─── Step 7: Load LaunchAgents ────────────────────────────────
echo ""
echo "Loading LaunchAgents..."

# Create log directories before loading
mkdir -p "$INSTALL_DIR/nerve/logs"

# Unload first if already loaded (ignore errors)
launchctl bootout "gui/$UID_NUM/ai.autonomy.nerve" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/ai.autonomy.garden" 2>/dev/null || true

# Load
launchctl bootstrap "gui/$UID_NUM" "$NERVE_PLIST" 2>/dev/null && \
  echo "  [ok] ai.autonomy.nerve loaded" || \
  echo "  [!!] ai.autonomy.nerve failed to load (check logs)"

launchctl bootstrap "gui/$UID_NUM" "$GARDEN_PLIST" 2>/dev/null && \
  echo "  [ok] ai.autonomy.garden loaded" || \
  echo "  [!!] ai.autonomy.garden failed to load (check logs)"

# ─── Step 8: Summary ─────────────────────────────────────────
echo ""
echo "============================================"
echo "  Installation Complete"
echo "============================================"
echo ""
echo "  Install directory:  $INSTALL_DIR"
echo "  Node.js:            $NODE_BIN ($NODE_VERSION)"
echo "  Claude CLI:         ${CLAUDE_BIN:-not found}"
echo ""
echo "  Directory layout:"
echo "    $INSTALL_DIR/"
echo "    ├── config.json"
echo "    ├── evolution/"
echo "    │   ├── requests/     # bridge request queue"
echo "    │   ├── responses/    # bridge response output"
echo "    │   ├── signals/      # metric collectors"
echo "    │   └── predictions/  # evolution predictions"
echo "    ├── nerve/"
echo "    │   ├── nerve-daemon.js"
echo "    │   ├── attention.json"
echo "    │   ├── cascades.json"
echo "    │   ├── sensors/      # sensor scripts"
echo "    │   ├── events/       # event archive"
echo "    │   └── logs/         # daemon logs"
echo "    └── garden/"
echo "        ├── garden-tender.js"
echo "        ├── seeds/        # new knowledge"
echo "        ├── growing/      # under validation"
echo "        ├── mature/       # validated knowledge"
echo "        └── compost/      # archived knowledge"
echo ""
echo "  LaunchAgents:"
echo "    ai.autonomy.nerve   — nerve daemon (always running)"
echo "    ai.autonomy.garden  — garden tender (daily at 3am)"
echo ""
echo "  Useful commands:"
echo "    launchctl print gui/$UID_NUM/ai.autonomy.nerve"
echo "    tail -f $INSTALL_DIR/nerve/logs/daemon-stdout.log"
echo "    $INSTALL_DIR/nerve/nerve-cli.sh status"
echo ""
echo "  To uninstall:"
echo "    launchctl bootout gui/$UID_NUM/ai.autonomy.nerve"
echo "    launchctl bootout gui/$UID_NUM/ai.autonomy.garden"
echo "    rm $LAUNCH_AGENTS/ai.autonomy.nerve.plist"
echo "    rm $LAUNCH_AGENTS/ai.autonomy.garden.plist"
echo ""
