#!/usr/bin/env node
/**
 * Bridge Daemon — the conversational agent ↔ Claude Code CLI
 *
 * Watches evolution/requests/ for new .md files.
 * When one appears with status "pending", spawns Claude Code CLI to handle it.
 * Writes response to evolution/responses/.
 * Runs 24/7 as a LaunchAgent.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');

const AGENT_HOME_DIR = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const REQUESTS = path.join(CLAWD, 'evolution', 'requests');
const RESPONSES = path.join(CLAWD, 'evolution', 'responses');
const SIGNALS = path.join(CLAWD, 'evolution', 'signals');
const BRIDGE_LOG = path.join(CLAWD, 'evolution', 'bridge.log');
const NERVE_SOCK = path.join(CLAWD, 'nerve', 'bus.sock');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const POLL_MS = 10_000; // check every 10s
const MAX_TIMEOUT_MS = 20 * 60 * 1000; // 20 min max per request
const MAX_RSS_MB = 1500; // kill child if RSS exceeds 1.5GB (prevent macOS OOM SIGKILL)
const RSS_CHECK_MS = 5_000; // check child memory every 5s
const MAX_PROMPT_CHARS = 15_000; // cap total prompt size to reduce memory pressure
const MAX_EVO_CONTEXT_CHARS = 3_000; // cap evolution context injection
const MAX_RETRIES = 1; // retry OOM'd requests once with simplified prompt

// ── Nerve event emission ────────────────────────────────────
function emitNerveEvent(event) {
  try {
    if (!fs.existsSync(NERVE_SOCK)) return;
    const client = net.createConnection(NERVE_SOCK, () => {
      client.write(JSON.stringify(event) + '\n');
      client.end();
    });
    client.on('error', () => {});
  } catch {}
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  fs.appendFileSync(BRIDGE_LOG, line);
  process.stdout.write(line);
}

// ── Memory monitoring ─────────────────────────────────────
/**
 * Get RSS (resident set size) in MB for a given PID.
 * Returns null if process doesn't exist or ps fails.
 */
function getProcessRssMb(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf-8', timeout: 2000,
    }).trim();
    if (!output) return null;
    return parseInt(output, 10) / 1024; // ps reports in KB on macOS
  } catch {
    return null;
  }
}

/**
 * Start periodic RSS monitoring for a child process.
 * Returns { stop(), killed } — call stop() when the process exits.
 * If RSS exceeds MAX_RSS_MB, kills the process with SIGTERM.
 */
function monitorChildMemory(proc, label) {
  const state = { killed: false, peakRssMb: 0 };
  const interval = setInterval(() => {
    if (!proc.pid) return;
    const rss = getProcessRssMb(proc.pid);
    if (rss === null) return;
    if (rss > state.peakRssMb) state.peakRssMb = rss;
    if (rss > MAX_RSS_MB) {
      log(`[bridge] OOM-GUARD: ${label} using ${rss.toFixed(0)}MB RSS (limit ${MAX_RSS_MB}MB) — killing`);
      state.killed = true;
      proc.kill('SIGTERM');
      // If SIGTERM doesn't work within 5s, escalate to SIGKILL
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }
  }, RSS_CHECK_MS);

  return {
    stop() { clearInterval(interval); },
    get killed() { return state.killed; },
    get peakRssMb() { return state.peakRssMb; },
  };
}

function ensureDirs() {
  [REQUESTS, RESPONSES].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

function extractPriority(content) {
  const m = content.match(/Priority:\*\*\s*P(\d)/i);
  return m ? parseInt(m[1]) : 2; // default P2
}

function getPendingRequests() {
  try {
    return fs.readdirSync(REQUESTS)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const content = fs.readFileSync(path.join(REQUESTS, f), 'utf8');
        return { file: f, content, path: path.join(REQUESTS, f), priority: extractPriority(content) };
      })
      .filter(r => r.content.includes('Status:** pending'))
      .sort((a, b) => a.priority - b.priority); // P0 first
  } catch (e) {
    return [];
  }
}

function markInProgress(reqPath, content) {
  const updated = content.replace('Status:** pending', 'Status:** in-progress');
  fs.writeFileSync(reqPath, updated);
}

function markCompleted(reqPath, content) {
  let updated = content.replace('Status:** in-progress', 'Status:** completed');
  fs.writeFileSync(reqPath, updated);
}

function markFailed(reqPath, content, reason) {
  let updated = content.replace('Status:** in-progress', `Status:** failed`);
  updated += `\n\n## Failure Reason\n${reason}\n`;
  fs.writeFileSync(reqPath, updated);
}

function getEvolutionContext(maxChars = MAX_EVO_CONTEXT_CHARS) {
  let context = '';
  // Inject STATE.md
  const statePath = path.join(CLAWD, 'evolution', 'STATE.md');
  try {
    if (fs.existsSync(statePath)) {
      const state = fs.readFileSync(statePath, 'utf8').trim();
      context += `## Current Evolution State\n\n${state}\n\n`;
    }
  } catch {}
  // Inject last 3 entries from tick-journal.md
  const journalPath = path.join(CLAWD, 'evolution', 'tick-journal.md');
  try {
    if (fs.existsSync(journalPath)) {
      const content = fs.readFileSync(journalPath, 'utf8');
      const entries = content.split(/\n(?=## )/).filter(e => e.trim());
      const last3 = entries.slice(-3).join('\n\n');
      if (last3.trim()) {
        context += `## Recent Evolution History\n\n${last3.trim()}\n\n`;
      }
    }
  } catch {}
  // Cap context size to prevent prompt bloat
  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '\n\n[...evolution context truncated for memory safety]\n';
    log(`[bridge] Evolution context truncated from ${context.length} to ${maxChars} chars`);
  }
  return context;
}

function buildPrompt(requestContent, requestFile) {
  const evoContext = getEvolutionContext();
  let prompt = `You are Claude Code, working autonomously as part of a co-evolution system with an AI agent called the conversational agent.

${evoContext}

WORKSPACE: ~/autonomy/
Read these files for context: SOUL.md, AGENTS.md, evolution/BRIDGE.md

A capability request has been filed by the conversational agent:

--- REQUEST (${requestFile}) ---
${requestContent}
--- END REQUEST ---

Do the work described in the request. Be thorough. Build real, working code and files. When done, write a response summary to: ~/autonomy/evolution/responses/${requestFile}

Use the response template from evolution/BRIDGE.md. Include what you did, files changed/created, and how to verify.

You have full access to the filesystem. Build whatever is needed. No restrictions.`;

  // Cap total prompt size
  if (prompt.length > MAX_PROMPT_CHARS) {
    log(`[bridge] Prompt for ${requestFile} is ${prompt.length} chars, exceeds ${MAX_PROMPT_CHARS}. Truncating.`);
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + '\n\n[...prompt truncated for memory safety. Focus on the core request above.]';
  }
  return prompt;
}

/**
 * Build a minimal prompt for OOM retries — no evolution context, shorter instructions.
 */
function buildMinimalPrompt(requestContent, requestFile) {
  let prompt = `You are Claude Code. WORKSPACE: ~/autonomy/

IMPORTANT: This is a retry after a previous OOM crash. Keep your work focused and minimal.

--- REQUEST (${requestFile}) ---
${requestContent}
--- END REQUEST ---

Do the work described above. Write response to: ~/autonomy/evolution/responses/${requestFile}
Include what you did and files changed.`;

  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS);
  }
  return prompt;
}

// ── Deliverable Validation ──────────────────────────────────────────────────

/**
 * Extract file paths mentioned in response text.
 */
function extractMentionedFiles(content) {
  const files = new Set();

  // Match ~/autonomy/... paths
  const agentDir = path.basename(CLAWD);
  const homePathRegex = new RegExp(`~/${agentDir}/[\\w\\-./]+`, 'g');
  const homePaths = content.match(homePathRegex) || [];
  for (const p of homePaths) {
    files.add(p.replace(`~/${agentDir}`, CLAWD));
  }

  // Match common relative paths under agent home
  for (const dir of ['evolution', 'garden', 'nerve', 'skills', 'scripts']) {
    const regex = new RegExp(`(?:^|[\\s|])${dir}\\/[\\w\\-./]+`, 'gm');
    const matches = content.match(regex) || [];
    for (const p of matches) {
      files.add(path.join(CLAWD, p.trim()));
    }
  }

  // Filter: must look like actual files (have extension)
  const filtered = [];
  for (const f of files) {
    if (f.match(/\.\w{1,6}$/)) filtered.push(f);
  }
  return filtered;
}

/**
 * Check which files were modified in the working tree.
 * Uses execFileSync (no shell) to avoid injection risks.
 */
function getFilesModifiedInWorkTree() {
  try {
    const diffOutput = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: CLAWD, encoding: 'utf-8', timeout: 5000,
    }).trim();
    const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: CLAWD, encoding: 'utf-8', timeout: 5000,
    }).trim();
    const combined = [diffOutput, untrackedOutput].filter(Boolean).join('\n');
    return combined ? combined.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Validate that a completed response actually produced deliverables.
 * Returns { valid, reason, details }.
 */
function validateDeliverables(stdout, requestContent) {
  const mentionedFiles = extractMentionedFiles(stdout);
  const modifiedFiles = getFilesModifiedInWorkTree();

  // Check 1: Does the response mention any files?
  if (mentionedFiles.length === 0) {
    // Check if the request expected file creation
    const expectsFiles = /\b(?:build|create|write|implement|add file|generate)\b/i.test(requestContent);
    if (expectsFiles) {
      return {
        valid: false,
        reason: 'Response mentions no files but request expected file creation',
        details: { mentionedFiles: [], existing: [], missing: [], modifiedFiles },
      };
    }
    return { valid: true, reason: 'No files expected or mentioned', details: {} };
  }

  // Check 2: Do mentioned files exist on disk?
  const existing = [];
  const missing = [];
  for (const f of mentionedFiles) {
    try {
      fs.accessSync(f);
      existing.push(f.replace(CLAWD + '/', ''));
    } catch {
      missing.push(f.replace(CLAWD + '/', ''));
    }
  }

  // Decision: fail if majority of mentioned files are missing
  const missingRatio = missing.length / mentionedFiles.length;

  if (missingRatio > 0.5) {
    return {
      valid: false,
      reason: `${missing.length}/${mentionedFiles.length} mentioned files are missing from disk`,
      details: { mentioned: mentionedFiles.map(f => f.replace(CLAWD + '/', '')), existing, missing, modifiedFiles },
    };
  }

  if (missing.length > 0) {
    return {
      valid: true,
      partial: true,
      reason: `${existing.length}/${mentionedFiles.length} files verified, ${missing.length} missing`,
      details: { mentioned: mentionedFiles.map(f => f.replace(CLAWD + '/', '')), existing, missing, modifiedFiles },
    };
  }

  return {
    valid: true,
    reason: `All ${existing.length} mentioned files verified on disk`,
    details: { mentioned: mentionedFiles.map(f => f.replace(CLAWD + '/', '')), existing, missing: [], modifiedFiles },
  };
}

/**
 * Log validation result to experiments.jsonl.
 */
function logValidationResult(reqFile, validation) {
  const experimentsPath = path.join(SIGNALS, 'experiments.jsonl');
  const entry = {
    id: `bridge-val-${reqFile.replace(/\.md$/, '').replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
    ts: new Date().toISOString(),
    type: 'bridge-validation',
    request: reqFile,
    valid: validation.valid,
    partial: validation.partial || false,
    reason: validation.reason,
    files_verified: (validation.details.existing || []).length,
    files_missing: (validation.details.missing || []).length,
  };
  try {
    fs.appendFileSync(experimentsPath, JSON.stringify(entry) + '\n');
  } catch {}
}

/**
 * Detect if a process exit was caused by OOM (SIGKILL from macOS kernel).
 * On macOS, OOM manifests as: code=null, signal='SIGKILL'.
 * Also catches our own OOM-guard kills (SIGTERM with memMonitor.killed).
 */
function isOomExit(code, signal, memMonitor) {
  if (memMonitor && memMonitor.killed) return true;
  if (signal === 'SIGKILL' && code === null) return true;
  return false;
}

/**
 * Run a single claude -p invocation with memory monitoring.
 * Returns { code, signal, stdout, stderr, timedOut, oomKilled, peakRssMb }
 */
function runClaudeProcess(prompt) {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'text'], {
      cwd: CLAWD,
      env: { ...process.env, HOME: process.env.HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Start memory monitoring
    const memMonitor = monitorChildMemory(proc, `claude-p[${proc.pid}]`);

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, MAX_TIMEOUT_MS);

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      memMonitor.stop();

      const oomKilled = isOomExit(code, signal, memMonitor);
      resolve({ code, signal, stdout, stderr, timedOut, oomKilled, peakRssMb: memMonitor.peakRssMb });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      memMonitor.stop();
      resolve({ code: -1, signal: null, stdout, stderr: err.message, timedOut, oomKilled: false, peakRssMb: memMonitor.peakRssMb });
    });
  });
}

async function processRequest(req) {
  log(`[bridge] Processing (P${req.priority}): ${req.file}`);
  markInProgress(req.path, req.content);

  const responsePath = path.join(RESPONSES, req.file);
  let attempt = 0;
  let lastResult = null;

  while (attempt <= MAX_RETRIES) {
    const isRetry = attempt > 0;
    const prompt = isRetry
      ? buildMinimalPrompt(req.content, req.file)
      : buildPrompt(req.content, req.file);

    if (isRetry) {
      log(`[bridge] RETRY (attempt ${attempt + 1}/${MAX_RETRIES + 1}) with minimal prompt for ${req.file}`);
    }

    log(`[bridge] Prompt size: ${prompt.length} chars (${isRetry ? 'minimal' : 'full'})`);

    const result = await runClaudeProcess(prompt);
    lastResult = result;

    // Log memory stats
    if (result.peakRssMb > 0) {
      log(`[bridge] Peak RSS for ${req.file}: ${result.peakRssMb.toFixed(0)}MB`);
    }

    // ── OOM detected — retry with minimal prompt ──
    if (result.oomKilled) {
      log(`[bridge] OOM-KILLED: ${req.file} (signal=${result.signal}, peak=${result.peakRssMb.toFixed(0)}MB)`);
      emitNerveEvent({
        source: 'bridge-daemon',
        type: 'bridge.oom',
        request: req.file,
        attempt: attempt + 1,
        peak_rss_mb: Math.round(result.peakRssMb),
        signal: result.signal,
      });

      if (attempt < MAX_RETRIES) {
        attempt++;
        // Brief pause before retry to let memory settle
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // All retries exhausted
      const reason = `OOM killed after ${attempt + 1} attempt(s). Peak RSS: ${result.peakRssMb.toFixed(0)}MB. Signal: ${result.signal}`;
      if (result.stdout.length > 0) {
        const response = `# Response: ${req.file}\n- **Request:** requests/${req.file}\n- **Status:** oom-failed\n- **Generated by:** Claude Code CLI (bridge-daemon)\n\n## Partial Output (OOM)\n\n${result.stdout.trim()}\n`;
        fs.writeFileSync(responsePath, response);
      }
      markFailed(req.path, fs.readFileSync(req.path, 'utf8'), reason);
      log(`[bridge] OOM-FAILED: ${req.file} — ${reason}`);
      logValidationResult(req.file, { valid: false, reason, details: {} });
      return;
    }

    // ── Timeout ──
    if (result.timedOut) {
      const reason = `Timed out after ${MAX_TIMEOUT_MS / 1000}s. ${result.stdout.length} chars captured. Peak RSS: ${result.peakRssMb.toFixed(0)}MB.`;
      if (result.stdout.length > 0) {
        const response = `# Response: ${req.file}\n- **Request:** requests/${req.file}\n- **Status:** timed-out (partial)\n- **Generated by:** Claude Code CLI (bridge-daemon)\n\n## Partial Output (timed out)\n\n${result.stdout.trim()}\n`;
        fs.writeFileSync(responsePath, response);
      }
      markFailed(req.path, fs.readFileSync(req.path, 'utf8'), reason);
      log(`[bridge] TIMED-OUT: ${req.file} — ${reason}`);
      logValidationResult(req.file, { valid: false, reason, details: {} });
      emitNerveEvent({ source: 'bridge-daemon', type: 'bridge.timeout', request: req.file, reason });
      return;
    }

    // ── Success ──
    if (result.code === 0 && result.stdout.length > 0) {
      const response = `# Response: ${req.file}\n- **Request:** requests/${req.file}\n- **Status:** completed\n- **Generated by:** Claude Code CLI (bridge-daemon)\n\n## Output\n\n${result.stdout.trim()}\n`;
      fs.writeFileSync(responsePath, response);

      const validation = validateDeliverables(result.stdout, req.content);
      logValidationResult(req.file, validation);

      if (!validation.valid) {
        const reason = `CLI exited 0 but validation failed: ${validation.reason}`;
        markFailed(req.path, fs.readFileSync(req.path, 'utf8'), reason);
        log(`[bridge] VALIDATION-FAILED: ${req.file} — ${reason}`);
        if (validation.details.missing) {
          log(`[bridge]   Missing: ${validation.details.missing.join(', ')}`);
        }
        emitNerveEvent({ source: 'bridge-daemon', type: 'bridge.validation_failed', request: req.file, reason });
      } else {
        markCompleted(req.path, fs.readFileSync(req.path, 'utf8'));
        const retryNote = isRetry ? ` [retry ${attempt}]` : '';
        if (validation.partial) {
          log(`[bridge] DONE (partial): ${req.file} — ${validation.reason}${retryNote}`);
        } else {
          log(`[bridge] DONE: ${req.file} (${result.stdout.length} chars, ${validation.reason}${retryNote})`);
        }
        emitNerveEvent({ source: 'bridge-daemon', type: 'bridge.completed', request: req.file, chars: result.stdout.length, retried: isRetry });
      }
      return;
    }

    // ── Other failure ──
    const reason = `Exit code ${result.code}, signal ${result.signal}. stderr: ${result.stderr.slice(0, 500)}`;
    markFailed(req.path, fs.readFileSync(req.path, 'utf8'), reason);
    log(`[bridge] FAILED: ${req.file} — ${reason}`);
    emitNerveEvent({ source: 'bridge-daemon', type: 'bridge.failed', request: req.file, reason });
    return;
  }
}

async function loop() {
  ensureDirs();
  log('[bridge] Bridge daemon started. Watching evolution/requests/');

  while (true) {
    const pending = getPendingRequests();

    if (pending.length > 0) {
      // Process one at a time to avoid OOM
      const req = pending[0];
      await processRequest(req);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

loop().catch(err => {
  log(`[bridge] Fatal: ${err.message}`);
  process.exit(1);
});
