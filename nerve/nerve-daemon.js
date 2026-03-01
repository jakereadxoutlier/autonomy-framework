#!/usr/bin/env node
// nerve-daemon.js — Event bus and attention router for AI agents
// Replaces crons with an event-driven nervous system.
// No npm dependencies. Pure Node.js stdlib.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Paths ───────────────────────────────────────────────────
const NERVE_DIR = path.resolve(__dirname);
const BUS_SOCK = path.join(NERVE_DIR, 'bus.sock');
const STREAM_LOG = path.join(NERVE_DIR, 'stream.jsonl');
const NERVE_LOG = path.join(NERVE_DIR, 'nerve.log');
const ATTENTION_FILE = path.join(NERVE_DIR, 'attention.json');
const CASCADES_FILE = path.join(NERVE_DIR, 'cascades.json');
const AWARENESS_FILE = path.join(NERVE_DIR, 'awareness.json');
const EVENT_DIR = path.join(NERVE_DIR, 'events');
const OPENCLAW_GATEWAY = 'http://127.0.0.1:18789';
const OPENCLAW_WAKE_PATH = '/api/cron/wake';

// ─── State ───────────────────────────────────────────────────
let attention = { rules: [] };
let cascades = { cascades: [] };
let recentHashes = new Map();  // hash → timestamp (for dedup)
let batches = { 1: [], 2: [] };  // P1 and P2 event batches
let batchTimers = { 1: null, 2: null };
const BATCH_DELAYS = { 1: 30000, 2: 300000 };  // 30s, 5min
const DEDUP_WINDOW = 60000;  // 60 seconds
const MAX_CASCADE_DEPTH = 5;
const MAX_EVENTS_PER_MIN = 100;
let eventsThisMinute = 0;
let lastMinuteReset = Date.now();

// ─── Logging ─────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(NERVE_LOG, line + '\n');
}

// ─── Config Loading ──────────────────────────────────────────
function loadConfig() {
  try {
    attention = JSON.parse(fs.readFileSync(ATTENTION_FILE, 'utf8'));
    log(`Loaded ${attention.rules.length} attention rules`);
  } catch (e) {
    log(`WARN: Could not load attention.json: ${e.message}`);
  }
  try {
    cascades = JSON.parse(fs.readFileSync(CASCADES_FILE, 'utf8'));
    log(`Loaded ${cascades.cascades.length} cascade rules`);
  } catch (e) {
    log(`WARN: Could not load cascades.json: ${e.message}`);
  }
}

// Watch config files for live reload
function watchConfigs() {
  for (const f of [ATTENTION_FILE, CASCADES_FILE]) {
    try {
      fs.watch(f, () => {
        log(`Config changed: ${path.basename(f)}, reloading`);
        loadConfig();
      });
    } catch (_) {}
  }
}

// ─── Glob Matching ───────────────────────────────────────────
// Simple glob: * matches any sequence of chars. No ** or [] needed.
function globMatch(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return regex.test(String(value));
}

// Check if an event matches a rule's match object
function matchesRule(match, event) {
  for (const [key, pattern] of Object.entries(match)) {
    const value = event[key];
    if (value === undefined) return false;
    // Handle array values (e.g. labels)
    if (Array.isArray(value)) {
      if (!value.some(v => globMatch(String(pattern), String(v)))) return false;
    } else {
      if (!globMatch(String(pattern), String(value))) return false;
    }
  }
  return true;
}

// ─── Priority Classification ─────────────────────────────────
function classify(event) {
  for (const rule of attention.rules) {
    if (matchesRule(rule.match, event)) {
      return { priority: rule.priority, reason: rule.reason || 'matched rule' };
    }
  }
  return { priority: 2, reason: 'default' };
}

// ─── Deduplication ───────────────────────────────────────────
function eventHash(event) {
  const { ts, timestamp, _nerve, ...rest } = event;  // exclude timestamps from hash
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
}

function isDuplicate(hash) {
  const now = Date.now();
  // Clean old entries
  for (const [h, t] of recentHashes) {
    if (now - t > DEDUP_WINDOW) recentHashes.delete(h);
  }
  if (recentHashes.has(hash)) return true;
  recentHashes.set(hash, now);
  return false;
}

// ─── Throttle ────────────────────────────────────────────────
function isThrottled() {
  const now = Date.now();
  if (now - lastMinuteReset > 60000) {
    eventsThisMinute = 0;
    lastMinuteReset = now;
  }
  eventsThisMinute++;
  return eventsThisMinute > MAX_EVENTS_PER_MIN;
}

// ─── Agent Wake ──────────────────────────────────────────────
function wakeAgent(events, reason) {
  const eventArray = Array.isArray(events) ? events : [events];
  const summary = eventArray.map(e =>
    `[P${e._nerve?.priority ?? '?'}] ${e.source}: ${e.type || e.msg || e.subject || e.path || 'event'}`
  ).join('; ');

  log(`WAKE: ${reason} — ${summary}`);

  // Write event payload to file for the agent to read
  fs.mkdirSync(EVENT_DIR, { recursive: true });
  const eventFile = path.join(EVENT_DIR, `wake-${Date.now()}.json`);
  fs.writeFileSync(eventFile, JSON.stringify(eventArray, null, 2));

  const wakeText = `NERVE EVENT: ${summary}. Details: ${eventFile}`;

  // Wake via OpenClaw gateway HTTP API
  // Tries PUT /api/cron/wake (the known endpoint from sentry-webhook/server.js)
  // If the gateway API changes, update OPENCLAW_WAKE_PATH and method below
  const data = JSON.stringify({ text: wakeText, mode: 'now' });
  const req = http.request({
    hostname: '127.0.0.1',
    port: 18789,
    path: OPENCLAW_WAKE_PATH,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    },
    timeout: 30000,
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log(`WAKE OK: agent notified (${res.statusCode})`);
      } else {
        log(`WAKE WARN: gateway returned ${res.statusCode}: ${body}`);
      }
    });
  });

  req.on('error', err => {
    log(`WAKE ERROR: ${err.message} — is the OpenClaw gateway running on port 18789?`);
  });

  req.write(data);
  req.end();
}

// ─── Batching ────────────────────────────────────────────────
function addToBatch(event, priority) {
  batches[priority].push(event);
  // Start timer if not already running
  if (!batchTimers[priority]) {
    batchTimers[priority] = setTimeout(() => flushBatch(priority), BATCH_DELAYS[priority]);
  }
}

function flushBatch(priority) {
  const events = batches[priority];
  batchTimers[priority] = null;
  batches[priority] = [];
  if (events.length > 0) {
    wakeAgent(events, `P${priority} batch (${events.length} events)`);
  }
}

// ─── Cascades ────────────────────────────────────────────────
function processCascades(event, depth = 0) {
  if (depth >= MAX_CASCADE_DEPTH) {
    log(`WARN: Cascade depth limit reached, dropping`);
    return;
  }
  for (const rule of cascades.cascades) {
    if (matchesRule(rule.trigger, event)) {
      log(`CASCADE: ${JSON.stringify(rule.trigger)} → ${rule.emit.length} events`);
      for (const emitted of rule.emit) {
        processEvent({ ...emitted, ts: Date.now(), _cascade_depth: depth + 1 }, depth + 1);
      }
    }
  }
}

// ─── Self-Schedule ───────────────────────────────────────────
function checkSelfSchedule() {
  let awareness;
  try {
    awareness = JSON.parse(fs.readFileSync(AWARENESS_FILE, 'utf8'));
  } catch {
    return;
  }
  if (!awareness.self_schedule || !Array.isArray(awareness.self_schedule)) return;

  const now = new Date();
  let modified = false;

  awareness.self_schedule = awareness.self_schedule.filter(entry => {
    const nextTime = new Date(entry.next);
    if (isNaN(nextTime.getTime())) return true;  // keep malformed entries
    if (nextTime <= now) {
      log(`SCHEDULE: Firing "${entry.check}" (reason: ${entry.reason || 'none'})`);
      const event = {
        source: 'self_schedule',
        type: 'scheduled_check',
        check: entry.check,
        reason: entry.reason || '',
        ts: Date.now()
      };
      processEvent(event, 0);
      modified = true;

      // Handle recurring entries
      if (entry.recur) {
        const ms = parseDuration(entry.recur);
        if (ms) {
          entry.next = new Date(now.getTime() + ms).toISOString();
          return true;  // keep with updated next time
        }
      }
      return false;  // remove one-shot entry
    }
    return true;
  });

  if (modified) {
    fs.writeFileSync(AWARENESS_FILE, JSON.stringify(awareness, null, 2));
  }
}

// Parse simple durations like "1h", "30m", "1d"
function parseDuration(str) {
  const m = String(str).match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1]);
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return n * unit;
}

// ─── Core Event Processing ───────────────────────────────────
function processEvent(event, cascadeDepth = 0) {
  // Throttle check
  if (isThrottled()) {
    log('THROTTLE: >100 events/min, dropping');
    return;
  }

  // Stamp the event
  event.ts = event.ts || Date.now();
  const hash = eventHash(event);

  // Dedup
  if (isDuplicate(hash)) {
    log(`DEDUP: Dropping duplicate ${hash}`);
    return;
  }

  // Classify
  const { priority, reason } = classify(event);
  event._nerve = { priority, reason, hash, received: new Date().toISOString() };

  // Log to stream (always)
  fs.appendFileSync(STREAM_LOG, JSON.stringify(event) + '\n');

  log(`EVENT: P${priority} [${event.source}] ${event.type || event.msg || event.path || ''} (${reason})`);

  // Route by priority
  switch (priority) {
    case 0:
      wakeAgent(event, 'P0 immediate');
      break;
    case 1:
      addToBatch(event, 1);
      break;
    case 2:
      addToBatch(event, 2);
      break;
    case 3:
    case 4:
      // Already logged to stream, nothing more to do
      break;
    default:
      addToBatch(event, 2);
  }

  // Process cascades
  processCascades(event, cascadeDepth);
}

// ─── Socket Server ───────────────────────────────────────────
function startServer() {
  // Clean up stale socket
  try { fs.unlinkSync(BUS_SOCK); } catch (_) {}

  const server = net.createServer(socket => {
    let buffer = '';

    socket.on('data', chunk => {
      buffer += chunk.toString();
      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop();  // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line.trim());
          processEvent(event);
        } catch (e) {
          log(`PARSE ERROR: ${e.message} — raw: ${line.slice(0, 200)}`);
        }
      }
    });

    socket.on('end', () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          processEvent(event);
        } catch (e) {
          log(`PARSE ERROR on close: ${e.message}`);
        }
      }
    });

    socket.on('error', err => {
      log(`SOCKET ERROR: ${err.message}`);
    });
  });

  server.on('error', err => {
    log(`SERVER ERROR: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('Socket in use — removing stale socket and retrying');
      fs.unlinkSync(BUS_SOCK);
      setTimeout(() => server.listen(BUS_SOCK), 1000);
    }
  });

  server.listen(BUS_SOCK, () => {
    log(`Nerve daemon listening on ${BUS_SOCK}`);
    // Make socket accessible
    fs.chmodSync(BUS_SOCK, 0o770);
  });

  return server;
}

// ─── Startup ─────────────────────────────────────────────────
const PID_FILE = path.join(NERVE_DIR, 'nerve.pid');
const startedAt = new Date().toISOString();

function main() {
  log('═══════════════════════════════════════════');
  log(`Nerve daemon starting (PID ${process.pid})`);

  // Write PID file for process management
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Check for competing daemon.js — warn if it's also trying to use bus.sock
  const competingPid = (() => {
    try {
      const dpid = path.join(NERVE_DIR, 'daemon.pid');
      if (fs.existsSync(dpid)) {
        const pid = parseInt(fs.readFileSync(dpid, 'utf8').trim());
        try { process.kill(pid, 0); return pid; } catch (_) { return null; }
      }
    } catch (_) {}
    return null;
  })();
  if (competingPid) {
    log(`WARN: Competing daemon.js running at PID ${competingPid} — may fight over bus.sock`);
  }

  // Ensure stream log exists
  if (!fs.existsSync(STREAM_LOG)) fs.writeFileSync(STREAM_LOG, '');

  // Load config
  loadConfig();
  watchConfigs();

  // Start socket server
  const server = startServer();

  // Self-schedule check interval (every 10s)
  const scheduleInterval = setInterval(checkSelfSchedule, 10000);

  // Update awareness with daemon state
  function updateAwarenessState() {
    try {
      const awareness = JSON.parse(fs.readFileSync(AWARENESS_FILE, 'utf8'));
      awareness.daemon_status = {
        running: true,
        pid: process.pid,
        started: startedAt,
        uptime_seconds: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
        events_this_minute: eventsThisMinute,
        p1_batch_size: batches[1].length,
        p2_batch_size: batches[2].length,
      };
      fs.writeFileSync(AWARENESS_FILE, JSON.stringify(awareness, null, 2));
    } catch (_) {}
  }
  const statusInterval = setInterval(updateAwarenessState, 30000);
  updateAwarenessState();

  // Graceful shutdown — only clean socket on SIGINT (manual stop),
  // NOT on SIGTERM (launchd restart) so KeepAlive restarts have less downtime
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;  // prevent double-shutdown
    shuttingDown = true;
    log(`Shutting down (${signal})`);
    clearInterval(scheduleInterval);
    clearInterval(statusInterval);
    // Flush any pending batches
    flushBatch(1);
    flushBatch(2);
    // Clean PID file
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    server.close(() => {
      // Only remove socket on intentional stop (SIGINT), not launchd restart (SIGTERM)
      if (signal === 'SIGINT') {
        try { fs.unlinkSync(BUS_SOCK); } catch (_) {}
      }
      log('Nerve daemon stopped');
      process.exit(0);
    });
    // Force exit after 5s if server doesn't close cleanly
    setTimeout(() => process.exit(0), 5000);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Catch uncaught errors to prevent silent crashes
  process.on('uncaughtException', (err) => {
    log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    // Don't exit — stay alive for launchd
  });
  process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED REJECTION: ${reason}`);
  });

  log('Nerve daemon ready');
}

main();
