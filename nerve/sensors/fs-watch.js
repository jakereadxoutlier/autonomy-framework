#!/usr/bin/env node
// fs-watch.js — File system event sensor for the nerve bus
// Pure Node.js replacement for fs-watch.sh — no fswatch/socat needed.
// Uses native fs.watch (macOS FSEvents) and net.connect for the Unix socket.

const fs = require('fs');
const path = require('path');
const net = require('net');

const NERVE_DIR = path.resolve(__dirname, '..');
const BUS_SOCK = path.join(NERVE_DIR, 'bus.sock');
const NERVE_LOG = path.join(NERVE_DIR, 'nerve.log');

// ─── Directories to watch ───────────────────────────────────
// Add your project directories here
const WATCH_DIRS = [
  process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy'),
  // path.join(process.env.HOME, 'my-project'),
];

// Patterns to exclude (checked against full path)
const EXCLUDES = [
  /\.log$/,
  /node_modules/,
  /\.git\//,
  /bus\.sock/,
  /stream\.jsonl/,
  /__pycache__/,
  /\.DS_Store/,
  /\.swp$/,
  /~$/,
];

// Debounce: don't send more than one event per file per N ms
const DEBOUNCE_MS = 2000;
const recentFiles = new Map(); // path → timestamp

function log(msg) {
  const line = `[${new Date().toISOString()}] [fs-watch] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(NERVE_LOG, line + '\n'); } catch (_) {}
}

function shouldExclude(filepath) {
  return EXCLUDES.some(re => re.test(filepath));
}

function isDebounced(filepath) {
  const now = Date.now();
  const last = recentFiles.get(filepath);
  if (last && now - last < DEBOUNCE_MS) return true;
  recentFiles.set(filepath, now);
  // Clean old entries every 1000 files
  if (recentFiles.size > 1000) {
    for (const [k, v] of recentFiles) {
      if (now - v > DEBOUNCE_MS * 2) recentFiles.delete(k);
    }
  }
  return false;
}

function sendEvent(filepath, eventType) {
  if (shouldExclude(filepath)) return;
  if (isDebounced(filepath)) return;

  const event = {
    source: 'fs',
    type: eventType,
    path: filepath,
    ts: Date.now(),
  };

  // Check socket exists before connecting
  if (!fs.existsSync(BUS_SOCK)) {
    log(`WARN: bus.sock not available, skipping event for ${filepath}`);
    return;
  }

  const client = net.createConnection(BUS_SOCK, () => {
    client.write(JSON.stringify(event) + '\n');
    client.end();
  });

  client.on('error', err => {
    log(`BUS ERROR: ${err.message}`);
  });

  client.setTimeout(5000, () => {
    client.destroy();
  });
}

// ─── Watch a directory recursively ──────────────────────────
function watchDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    log(`SKIP: ${dirPath} does not exist`);
    return;
  }

  try {
    const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(dirPath, filename);
      const nerveType = eventType === 'rename' ? 'file_renamed' : 'file_changed';
      sendEvent(fullPath, nerveType);
    });

    watcher.on('error', err => {
      log(`WATCH ERROR on ${dirPath}: ${err.message}`);
      // Re-establish watch after a delay
      setTimeout(() => watchDir(dirPath), 5000);
    });

    log(`Watching: ${dirPath}`);
  } catch (err) {
    log(`FAILED to watch ${dirPath}: ${err.message}`);
  }
}

// ─── Startup ────────────────────────────────────────────────
log('═══ fs-watch sensor starting ═══');
log(`PID: ${process.pid}`);

for (const dir of WATCH_DIRS) {
  watchDir(dir);
}

log('fs-watch sensor ready');

// Keep process alive
process.on('SIGTERM', () => {
  log('fs-watch sensor shutting down (SIGTERM)');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('fs-watch sensor shutting down (SIGINT)');
  process.exit(0);
});
