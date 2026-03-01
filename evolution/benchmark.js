#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = path.resolve(__dirname, '..');
const SIGNALS = path.join(__dirname, 'signals');
const BENCH_FILE = path.join(SIGNALS, 'benchmark.json');

function count(fn) { try { return fn(); } catch { return 0; } }

function countSkills() {
  const dir = path.join(BASE, 'skills');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(d => {
    try { return fs.statSync(path.join(dir, d)).isDirectory() && fs.existsSync(path.join(dir, d, 'SKILL.md')); } catch { return false; }
  }).length;
}

function countGardenByStage() {
  const gardenDir = path.join(BASE, 'garden');
  const stages = {};
  if (!fs.existsSync(gardenDir)) return stages;
  for (const f of fs.readdirSync(gardenDir)) {
    const fp = path.join(gardenDir, f);
    if (!f.endsWith('.md') || !fs.statSync(fp).isFile()) continue;
    const content = fs.readFileSync(fp, 'utf8');
    const m = content.match(/stage[:\s]*(\w+)/i);
    const stage = m ? m[1].toLowerCase() : 'unknown';
    stages[stage] = (stages[stage] || 0) + 1;
  }
  return stages;
}

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length; } catch { return 0; }
}

function countDir(dir) {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

function checkNerveDaemon() {
  try { return fs.existsSync(path.join(BASE, 'nerve', 'bus.sock')); } catch { return false; }
}

function checkGardenTender() {
  const script = path.join(BASE, 'garden', 'garden-tender.js');
  if (!fs.existsSync(script)) return false;
  try { execSync(`node ${script} --dry-run 2>/dev/null`, { timeout: 5000 }); return true; } catch { return false; }
}

const now = new Date().toISOString();
const bench = {
  timestamp: now,
  skills_count: countSkills(),
  garden_by_stage: countGardenByStage(),
  garden_total: Object.values(countGardenByStage()).reduce((a, b) => a + b, 0),
  experiments_count: countLines(path.join(SIGNALS, 'experiments.jsonl')),
  bridge_responses: countDir(path.join(__dirname, 'responses')),
  tick_journal_lines: countLines(path.join(__dirname, 'tick-journal.md')),
  nerve_daemon_ready: checkNerveDaemon(),
  garden_tender_ok: checkGardenTender(),
};

// Compare to previous
let prev = null;
if (fs.existsSync(BENCH_FILE)) {
  try { prev = JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8')); } catch {}
}

console.log('=== Evolution Benchmark ===');
console.log(`Timestamp: ${now}`);
for (const [k, v] of Object.entries(bench)) {
  if (k === 'timestamp' || k === 'garden_by_stage') continue;
  let delta = '';
  if (prev && prev[k] !== undefined && typeof v === 'number') {
    const d = v - prev[k];
    if (d !== 0) delta = ` (${d > 0 ? '+' : ''}${d} since last benchmark)`;
  }
  console.log(`  ${k}: ${v}${delta}`);
}
if (Object.keys(bench.garden_by_stage).length) {
  console.log('  garden stages:', JSON.stringify(bench.garden_by_stage));
}

fs.writeFileSync(BENCH_FILE, JSON.stringify(bench, null, 2) + '\n');
console.log(`\nWritten to ${BENCH_FILE}`);
