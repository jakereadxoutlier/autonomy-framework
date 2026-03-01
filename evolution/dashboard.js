#!/usr/bin/env node
// Evolution Dashboard — terminal status report for the co-evolution system
// No dependencies. Pure Node.js. Run: node evolution/dashboard.js

const fs = require('fs');
const path = require('path');

// ── ANSI Colors & Styles ────────────────────────────────────────────────────

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  // foreground
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  // bright
  brightRed:    '\x1b[91m',
  brightGreen:  '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan:   '\x1b[96m',
  brightWhite:  '\x1b[97m',
  // background
  bgRed:     '\x1b[41m',
  bgGreen:   '\x1b[42m',
  bgYellow:  '\x1b[43m',
  bgBlue:    '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

// ── Box Drawing ─────────────────────────────────────────────────────────────

const box = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  ltee: '├', rtee: '┤',
  sep: '┈',
};

const BASE = path.resolve(__dirname, '..');
const EVO  = path.resolve(__dirname);

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJsonl(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function countFiles(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).length;
  } catch { return 0; }
}

function fileExists(filePath) {
  try { fs.accessSync(filePath); return true; }
  catch { return false; }
}

function readDir(dirPath) {
  try { return fs.readdirSync(dirPath).filter(f => !f.startsWith('.')); }
  catch { return []; }
}

function timeAgo(ts) {
  const now = Date.now();
  let then;
  if (typeof ts === 'number') {
    then = ts;
  } else if (typeof ts === 'string') {
    then = new Date(ts).getTime();
  } else {
    return 'unknown';
  }
  if (isNaN(then)) return 'unknown';
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function hoursRemaining(appliedStr, windowHours) {
  if (!appliedStr || !windowHours) return null;
  const applied = new Date(appliedStr).getTime();
  const end = applied + windowHours * 3600000;
  const remaining = end - Date.now();
  if (remaining <= 0) return 0;
  return Math.round(remaining / 3600000 * 10) / 10;
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len - 1) + '…';
}

function pad(str, len) {
  str = String(str || '');
  if (str.length >= len) return str.slice(0, len);
  return str + ' '.repeat(len - str.length);
}

function padLeft(str, len) {
  str = String(str || '');
  if (str.length >= len) return str.slice(0, len);
  return ' '.repeat(len - str.length) + str;
}

// ── Section Rendering ───────────────────────────────────────────────────────

const WIDTH = 78;

function banner(title, color) {
  const inner = WIDTH - 4;
  const label = ` ${title} `;
  const leftPad = Math.floor((inner - label.length) / 2);
  const rightPad = inner - label.length - leftPad;
  console.log('');
  console.log(`${color}${box.tl}${box.h.repeat(inner + 2)}${box.tr}${c.reset}`);
  console.log(`${color}${box.v}${' '.repeat(leftPad)}${c.bold}${label}${c.reset}${color}${' '.repeat(rightPad)}${box.v}${c.reset}`);
  console.log(`${color}${box.bl}${box.h.repeat(inner + 2)}${box.br}${c.reset}`);
}

function sectionHeader(title, icon) {
  const line = box.h.repeat(WIDTH - title.length - 5);
  console.log(`\n${c.bold}${c.cyan}${icon} ${title} ${c.dim}${line}${c.reset}`);
}

function emptyState(msg) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

// ── Status Badge ────────────────────────────────────────────────────────────

function statusBadge(status) {
  const s = (status || '').toLowerCase();
  if (s === 'measuring')   return `${c.yellow}● measuring${c.reset}`;
  if (s === 'success')     return `${c.green}✔ success${c.reset}`;
  if (s === 'failed')      return `${c.red}✘ failed${c.reset}`;
  if (s === 'rolled-back') return `${c.magenta}↩ rolled-back${c.reset}`;
  if (s === 'proposed')    return `${c.blue}◎ proposed${c.reset}`;
  if (s === 'applied')     return `${c.green}✔ applied${c.reset}`;
  if (s === 'rejected')    return `${c.red}✘ rejected${c.reset}`;
  if (s === 'pending')     return `${c.yellow}◌ pending${c.reset}`;
  if (s === 'in-progress') return `${c.cyan}⟳ in-progress${c.reset}`;
  if (s === 'completed')   return `${c.green}✔ completed${c.reset}`;
  return `${c.gray}? ${s || 'unknown'}${c.reset}`;
}

function severityBadge(sev) {
  const n = Number(sev);
  if (n >= 5) return `${c.bgRed}${c.brightWhite} SEV-${n} ${c.reset}`;
  if (n >= 4) return `${c.red} SEV-${n} ${c.reset}`;
  if (n >= 3) return `${c.yellow} SEV-${n} ${c.reset}`;
  if (n >= 2) return `${c.blue} SEV-${n} ${c.reset}`;
  return `${c.dim} SEV-${n} ${c.reset}`;
}

// ── Sections ────────────────────────────────────────────────────────────────

function renderExperiments() {
  sectionHeader('Active Experiments', '🧪');
  const experiments = readJsonl(path.join(EVO, 'signals', 'experiments.jsonl'));
  if (experiments.length === 0) {
    emptyState('No experiments recorded yet.');
    return;
  }
  for (const exp of experiments) {
    const remaining = hoursRemaining(exp.applied, exp.window_hours);
    const remainStr = remaining !== null
      ? (remaining > 0 ? `${remaining}h left` : `${c.green}window closed${c.reset}`)
      : '';
    console.log(`  ${c.bold}${exp.id}${c.reset}  ${statusBadge(exp.status)}  ${c.dim}${timeAgo(exp.applied)}${c.reset}`);
    console.log(`    ${c.gray}target:${c.reset} ${exp.target}  ${c.gray}signal:${c.reset} ${exp.signal || '—'}`);
    if (exp.window_hours) {
      console.log(`    ${c.gray}window:${c.reset} ${exp.window_hours}h  ${c.gray}remaining:${c.reset} ${remainStr}`);
    }
    if (exp.detail) {
      console.log(`    ${c.dim}${truncate(exp.detail, WIDTH - 6)}${c.reset}`);
    }
    console.log('');
  }
}

function renderSignals() {
  sectionHeader('Recent Signals', '📡');
  const signals = readJsonl(path.join(EVO, 'signals', 'failures.jsonl'));
  if (signals.length === 0) {
    emptyState('No signals recorded yet.');
    return;
  }
  const last10 = signals.slice(-10);
  for (const sig of last10) {
    const ts = sig.ts ? timeAgo(sig.ts) : '?';
    const type = pad(sig.type || '?', 16);
    console.log(`  ${c.dim}${padLeft(ts, 8)}${c.reset}  ${severityBadge(sig.severity)}  ${c.cyan}${type}${c.reset}`);
    console.log(`    ${truncate(sig.detail || '—', WIDTH - 6)}`);
  }
}

function renderProposals() {
  sectionHeader('Proposals', '📋');
  const proposalDir = path.join(EVO, 'proposals');
  const files = readDir(proposalDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    emptyState('No proposals filed.');
    return;
  }
  for (const file of files) {
    const content = fs.readFileSync(path.join(proposalDir, file), 'utf-8');
    // extract title from first # line
    const titleMatch = content.match(/^#\s+(?:Proposal:\s*)?(.+)/m);
    const title = titleMatch ? titleMatch[1].trim() : file;
    // extract target
    const targetMatch = content.match(/\*\*Target:\*\*\s*(.+)/);
    const target = targetMatch ? targetMatch[1].trim() : '—';
    // extract status
    const statusMatch = content.match(/\*\*Status:\*\*\s*(\S+)/);
    const status = statusMatch ? statusMatch[1].trim() : 'unknown';

    console.log(`  ${c.bold}${truncate(title, WIDTH - 4)}${c.reset}`);
    console.log(`    ${statusBadge(status)}  ${c.gray}target:${c.reset} ${target}`);
    console.log(`    ${c.dim}${file}${c.reset}`);
    console.log('');
  }
}

function renderNerve() {
  sectionHeader('Nervous System', '⚡');

  const sockPath = path.join(BASE, 'nerve', 'bus.sock');
  const sockExists = fileExists(sockPath);

  if (!sockExists) {
    emptyState('Nerve daemon not running (no bus.sock).');
    return;
  }

  console.log(`  ${c.green}●${c.reset} ${c.bold}Nerve daemon active${c.reset}  ${c.dim}bus.sock found${c.reset}`);

  // awareness state
  const awareness = readJson(path.join(BASE, 'nerve', 'awareness.json'));
  if (awareness) {
    const ds = awareness.daemon_status;
    if (ds) {
      const uptime = ds.started ? timeAgo(ds.started) : '?';
      console.log(`  ${c.gray}pid:${c.reset} ${ds.pid || '?'}  ${c.gray}started:${c.reset} ${uptime}  ${c.gray}events/min:${c.reset} ${ds.events_this_minute || 0}`);
    }
    console.log(`  ${c.gray}pending:${c.reset} ${awareness.pending_events || 0}  ${c.gray}concerns:${c.reset} ${(awareness.active_concerns || []).length}`);
  }

  // last 5 stream events
  const stream = readJsonl(path.join(BASE, 'nerve', 'stream.jsonl'));
  if (stream.length > 0) {
    console.log(`\n  ${c.dim}Last events:${c.reset}`);
    const last5 = stream.slice(-5);
    for (const evt of last5) {
      const ts = evt.ts ? timeAgo(evt.ts) : (evt._nerve?.received ? timeAgo(evt._nerve.received) : '?');
      const src = pad(evt.source || '?', 8);
      const type = evt.type || evt.msg || '—';
      const prio = evt._nerve?.priority;
      const prioStr = prio !== undefined ? `P${prio}` : '  ';
      const prioColor = prio === 0 ? c.red : prio === 1 ? c.yellow : c.dim;
      console.log(`    ${c.dim}${padLeft(ts, 8)}${c.reset}  ${prioColor}${prioStr}${c.reset}  ${c.cyan}${src}${c.reset}  ${truncate(String(type), WIDTH - 30)}`);
    }
  }
}

function renderGarden() {
  sectionHeader('Knowledge Garden', '🌱');

  const gardenPath = path.join(BASE, 'garden');
  if (!fileExists(gardenPath)) {
    emptyState('No garden/ directory found.');
    return;
  }

  const stages = ['seeds', 'growing', 'mature', 'compost'];
  const icons  = ['🌰', '🌿', '🌳', '🍂'];
  const colors = [c.yellow, c.green, c.brightGreen, c.dim];

  let total = 0;
  const counts = stages.map((stage, i) => {
    const count = countFiles(path.join(gardenPath, stage));
    total += count;
    return { stage, count, icon: icons[i], color: colors[i] };
  });

  // bar chart
  const maxCount = Math.max(...counts.map(s => s.count), 1);
  const barMax = 30;

  for (const s of counts) {
    const barLen = Math.round((s.count / maxCount) * barMax);
    const bar = '█'.repeat(barLen) + '░'.repeat(barMax - barLen);
    console.log(`  ${s.icon} ${s.color}${pad(s.stage, 8)}${c.reset}  ${s.color}${bar}${c.reset}  ${c.bold}${s.count}${c.reset}`);
  }
  console.log(`  ${c.dim}total: ${total} ideas${c.reset}`);

  // list seeds (they're typically the most interesting)
  const seedFiles = readDir(path.join(gardenPath, 'seeds'));
  if (seedFiles.length > 0) {
    console.log(`\n  ${c.dim}Seeds:${c.reset}`);
    for (const f of seedFiles.slice(0, 5)) {
      console.log(`    ${c.yellow}•${c.reset} ${f.replace(/\.md$/, '')}`);
    }
  }
}

function renderBridge() {
  sectionHeader('Bridge Status', '🌉');

  const reqDir = path.join(EVO, 'requests');
  const resDir = path.join(EVO, 'responses');

  const requests  = readDir(reqDir).filter(f => f.endsWith('.md'));
  const responses = readDir(resDir).filter(f => f.endsWith('.md'));
  const responseSet = new Set(responses);

  const pending = [];
  const completed = [];
  const inProgress = [];

  for (const file of requests) {
    if (responseSet.has(file)) {
      completed.push(file);
    } else {
      // check if it's in-progress or pending by reading first few lines
      try {
        const content = fs.readFileSync(path.join(reqDir, file), 'utf-8');
        if (content.includes('in-progress')) {
          inProgress.push(file);
        } else {
          pending.push(file);
        }
      } catch {
        pending.push(file);
      }
    }
  }

  console.log(`  ${c.green}✔ ${completed.length} completed${c.reset}  ${c.cyan}⟳ ${inProgress.length} in-progress${c.reset}  ${c.yellow}◌ ${pending.length} pending${c.reset}`);

  if (inProgress.length > 0) {
    console.log(`\n  ${c.dim}In progress:${c.reset}`);
    for (const f of inProgress) {
      console.log(`    ${c.cyan}⟳${c.reset} ${f}`);
    }
  }
  if (pending.length > 0) {
    console.log(`\n  ${c.dim}Pending:${c.reset}`);
    for (const f of pending) {
      console.log(`    ${c.yellow}◌${c.reset} ${f}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  banner('EVOLUTION DASHBOARD', c.magenta);
  console.log(`${c.dim}  ${now}${c.reset}`);

  renderExperiments();
  renderSignals();
  renderProposals();
  renderNerve();
  renderGarden();
  renderBridge();

  // footer
  console.log(`\n${c.dim}${box.h.repeat(WIDTH)}${c.reset}`);
  console.log(`${c.dim}  run: node evolution/dashboard.js${c.reset}`);
  console.log('');
}

main();
