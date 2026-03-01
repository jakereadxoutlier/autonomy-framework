#!/usr/bin/env node
/**
 * Task Server — Lightweight HTTP API for async task dispatch
 *
 * Provides a localhost HTTP endpoint that the agent (or any agent) can POST tasks to.
 * Tasks are queued and processed by the bridge daemon (claude -p).
 * Completion events are emitted through the nerve system.
 *
 * This solves the core problem: sessions_spawn times out, but a simple
 * HTTP POST to localhost is fast and reliable.
 *
 * Endpoints:
 *   POST /task         — Submit a new task (returns task ID immediately)
 *   GET  /task/:id     — Check task status
 *   GET  /tasks        — List recent tasks with status
 *   GET  /health       — Health check
 *   POST /drain        — Drain deferred-tasks.jsonl into queue
 *
 * Port: 4247 (configurable via TASK_SERVER_PORT env var)
 * Runs as LaunchAgent: ai.autonomy.taskserver
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFileSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.TASK_SERVER_PORT || '4247');
const AGENT_HOME_DIR = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const REQUESTS_DIR = path.join(CLAWD, 'evolution', 'requests');
const RESPONSES_DIR = path.join(CLAWD, 'evolution', 'responses');
const SIGNALS_DIR = path.join(CLAWD, 'evolution', 'signals');
const TASK_DB = path.join(SIGNALS_DIR, 'task-queue.jsonl');
const DEFERRED_TASKS = path.join(SIGNALS_DIR, 'deferred-tasks.jsonl');
const TASK_LOG = path.join(CLAWD, 'evolution', 'task-server.log');
const NERVE_SOCK = path.join(CLAWD, 'nerve', 'bus.sock');
const POLL_INTERVAL_MS = 5_000; // check for completed tasks every 5s

// ── State ───────────────────────────────────────────────────
const tasks = new Map(); // id → task object
let taskServerStarted = null;

// ── Logging ─────────────────────────────────────────────────
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(TASK_LOG, line);
  process.stdout.write(line);
}

// ── Ensure directories ──────────────────────────────────────
function ensureDirs() {
  for (const d of [REQUESTS_DIR, RESPONSES_DIR, SIGNALS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Task ID generation ──────────────────────────────────────
function genId() {
  return `task-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── Slugify for filenames ───────────────────────────────────
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

// ── Nerve event emission ────────────────────────────────────
function emitNerveEvent(event) {
  try {
    if (!fs.existsSync(NERVE_SOCK)) return;
    const client = net.createConnection(NERVE_SOCK, () => {
      client.write(JSON.stringify(event) + '\n');
      client.end();
    });
    client.on('error', () => {}); // silently fail — nerve might be down
  } catch {}
}

// ── Persist task to JSONL ───────────────────────────────────
function persistTask(task) {
  try {
    fs.appendFileSync(TASK_DB, JSON.stringify(task) + '\n');
  } catch {}
}

// ── Load tasks from JSONL on startup ────────────────────────
function loadTasks() {
  try {
    if (!fs.existsSync(TASK_DB)) return;
    const lines = fs.readFileSync(TASK_DB, 'utf8').trim().split('\n').filter(Boolean);
    // Build state from log: latest entry for each id wins
    for (const line of lines) {
      try {
        const task = JSON.parse(line);
        if (task.id) tasks.set(task.id, task);
      } catch {}
    }
    log(`[task-server] Loaded ${tasks.size} tasks from disk`);
  } catch {}
}

// ── Create request file for bridge daemon ───────────────────
function createRequestFile(task) {
  const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const filename = `${ts}-${slugify(task.title)}.md`;
  const reqPath = path.join(REQUESTS_DIR, filename);

  const priority = task.priority || 'P2-normal';
  const content = `# Request: ${task.title}
- **From:** ${task.from || 'task-server'}
- **Priority:** ${priority}
- **Type:** ${task.type || 'capability-gap'}
- **Status:** pending
- **Task-ID:** ${task.id}

## Context
${task.context || 'Dispatched via task-server API.'}

## Task
${task.body}

## Acceptance Criteria
${task.criteria || 'Task is completed successfully. Response file exists.'}
`;

  fs.writeFileSync(reqPath, content);
  return filename;
}

// ── Check for completed tasks ───────────────────────────────
function checkCompletions() {
  for (const [id, task] of tasks) {
    if (task.status !== 'queued' && task.status !== 'processing') continue;

    const reqPath = path.join(REQUESTS_DIR, task.request_file);
    const respPath = path.join(RESPONSES_DIR, task.request_file);

    try {
      // Check if request file was marked completed/failed
      if (fs.existsSync(reqPath)) {
        const content = fs.readFileSync(reqPath, 'utf8');
        if (content.includes('Status:** completed')) {
          task.status = 'completed';
          task.completed_at = new Date().toISOString();
          if (fs.existsSync(respPath)) {
            task.response_file = `evolution/responses/${task.request_file}`;
          }
          persistTask(task);
          log(`[task-server] Task completed: ${id} (${task.title})`);
          emitNerveEvent({
            source: 'task-server',
            type: 'task.completed',
            task_id: id,
            title: task.title,
            response_file: task.response_file || null,
          });
        } else if (content.includes('Status:** failed')) {
          task.status = 'failed';
          task.failed_at = new Date().toISOString();
          // Try to extract failure reason
          const reasonMatch = content.match(/## Failure Reason\n([\s\S]*?)(?:\n##|$)/);
          task.failure_reason = reasonMatch ? reasonMatch[1].trim() : 'unknown';
          persistTask(task);
          log(`[task-server] Task failed: ${id} (${task.title})`);
          emitNerveEvent({
            source: 'task-server',
            type: 'task.failed',
            task_id: id,
            title: task.title,
            reason: task.failure_reason,
          });
        } else if (content.includes('Status:** in-progress') && task.status === 'queued') {
          task.status = 'processing';
          task.started_at = new Date().toISOString();
          persistTask(task);
          log(`[task-server] Task processing: ${id} (${task.title})`);
        }
      }
    } catch {}
  }
}

// ── Drain deferred tasks ────────────────────────────────────
function drainDeferred() {
  try {
    if (!fs.existsSync(DEFERRED_TASKS)) return { drained: 0 };

    const content = fs.readFileSync(DEFERRED_TASKS, 'utf8').trim();
    if (!content) return { drained: 0 };

    const lines = content.split('\n').filter(Boolean);
    let drained = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.status === 'drained') continue;

        const task = {
          id: genId(),
          title: entry.title || 'Deferred task',
          body: entry.body || entry.detail || '',
          from: 'deferred-drain',
          priority: entry.priority || 'P2-normal',
          type: entry.type || 'capability-gap',
          status: 'queued',
          created_at: entry.ts || new Date().toISOString(),
          drained_at: new Date().toISOString(),
        };

        task.request_file = createRequestFile(task);
        tasks.set(task.id, task);
        persistTask(task);
        drained++;
        log(`[task-server] Drained deferred task: ${task.id} (${task.title})`);
      } catch (e) {
        log(`[task-server] Failed to drain entry: ${e.message}`);
      }
    }

    // Clear deferred file (all entries have been drained)
    if (drained > 0) {
      fs.writeFileSync(DEFERRED_TASKS, '');
      log(`[task-server] Drained ${drained} deferred tasks`);
    }

    return { drained };
  } catch (e) {
    return { drained: 0, error: e.message };
  }
}

// ── HTTP Request Handling ───────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
    setTimeout(() => reject(new Error('Body read timeout')), 30000);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // CORS for local tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /task — Submit new task ──────────────────────────
  if (method === 'POST' && url.pathname === '/task') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);

      if (!data.title || !data.body) {
        return jsonResponse(res, 400, { error: 'Missing required fields: title, body' });
      }

      const task = {
        id: genId(),
        title: data.title,
        body: data.body,
        from: data.from || 'api',
        priority: data.priority || 'P2-normal',
        type: data.type || 'capability-gap',
        context: data.context || '',
        criteria: data.criteria || '',
        status: 'queued',
        created_at: new Date().toISOString(),
      };

      // Create the bridge request file
      task.request_file = createRequestFile(task);
      tasks.set(task.id, task);
      persistTask(task);

      log(`[task-server] Task queued: ${task.id} (${task.title}) → ${task.request_file}`);

      emitNerveEvent({
        source: 'task-server',
        type: 'task.queued',
        task_id: task.id,
        title: task.title,
      });

      return jsonResponse(res, 201, {
        id: task.id,
        status: 'queued',
        request_file: task.request_file,
        message: 'Task queued for bridge daemon processing',
      });
    } catch (e) {
      return jsonResponse(res, 400, { error: `Invalid request: ${e.message}` });
    }
  }

  // ── GET /task/:id — Check task status ─────────────────────
  if (method === 'GET' && url.pathname.startsWith('/task/')) {
    const id = url.pathname.slice(6);
    const task = tasks.get(id);
    if (!task) {
      return jsonResponse(res, 404, { error: 'Task not found' });
    }
    return jsonResponse(res, 200, task);
  }

  // ── GET /tasks — List recent tasks ────────────────────────
  if (method === 'GET' && url.pathname === '/tasks') {
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const statusFilter = url.searchParams.get('status');

    let taskList = Array.from(tasks.values());
    if (statusFilter) {
      taskList = taskList.filter(t => t.status === statusFilter);
    }
    taskList.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    taskList = taskList.slice(0, limit);

    return jsonResponse(res, 200, {
      total: tasks.size,
      showing: taskList.length,
      tasks: taskList,
    });
  }

  // ── POST /drain — Drain deferred tasks ────────────────────
  if (method === 'POST' && url.pathname === '/drain') {
    const result = drainDeferred();
    return jsonResponse(res, 200, result);
  }

  // ── GET /health — Health check ────────────────────────────
  if (method === 'GET' && url.pathname === '/health') {
    const active = Array.from(tasks.values()).filter(t => t.status === 'queued' || t.status === 'processing').length;
    const completed = Array.from(tasks.values()).filter(t => t.status === 'completed').length;
    const failed = Array.from(tasks.values()).filter(t => t.status === 'failed').length;

    return jsonResponse(res, 200, {
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - taskServerStarted) / 1000),
      tasks: { total: tasks.size, active, completed, failed },
      bridge_daemon: isBridgeRunning() ? 'running' : 'down',
    });
  }

  // ── 404 ───────────────────────────────────────────────────
  jsonResponse(res, 404, { error: 'Not found' });
}

// ── Check if bridge daemon is running ───────────────────────
function isBridgeRunning() {
  try {
    const result = execFileSync('pgrep', ['-f', 'node.*bridge-daemon'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Startup ─────────────────────────────────────────────────
function main() {
  ensureDirs();
  loadTasks();

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e) {
      log(`[task-server] HTTP error: ${e.message}`);
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    taskServerStarted = Date.now();
    log(`[task-server] Listening on http://127.0.0.1:${PORT}`);
    log(`[task-server] Endpoints: POST /task, GET /task/:id, GET /tasks, GET /health, POST /drain`);
  });

  // Periodically check for task completions
  setInterval(checkCompletions, POLL_INTERVAL_MS);

  // Drain deferred tasks on startup
  drainDeferred();

  // Periodically drain deferred tasks (every 60s)
  setInterval(drainDeferred, 60_000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('[task-server] Shutting down (SIGINT)');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
  process.on('SIGTERM', () => {
    log('[task-server] Shutting down (SIGTERM)');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });

  process.on('uncaughtException', (err) => {
    log(`[task-server] UNCAUGHT: ${err.message}\n${err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`[task-server] UNHANDLED: ${reason}`);
  });

  log('[task-server] Task server ready');
}

main();
