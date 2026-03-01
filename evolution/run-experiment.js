#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SIGNALS = path.join(__dirname, 'signals');
const EXPERIMENTS_FILE = path.join(SIGNALS, 'experiments.jsonl');
const TICK_LOG = path.join(SIGNALS, 'tick-log.jsonl');

function getCurrentTick() {
  try {
    const lines = fs.readFileSync(TICK_LOG, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return 0;
    return JSON.parse(lines[lines.length - 1]).tick || 0;
  } catch { return 0; }
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main() {
  let input = process.argv[2] || await readStdin();
  if (!input) { console.error('Usage: echo \'{"hypothesis":"..."}\' | node run-experiment.js'); process.exit(1); }

  let exp;
  try { exp = JSON.parse(input); } catch (e) { console.error('Invalid JSON:', e.message); process.exit(1); }

  const tick = getCurrentTick();
  const entry = {
    id: `exp-${Date.now()}`,
    ...exp,
    status: 'running',
    start_tick: tick,
    end_tick: tick + (exp.duration_ticks || 10),
    started_at: new Date().toISOString(),
    verdict: null,
  };

  fs.appendFileSync(EXPERIMENTS_FILE, JSON.stringify(entry) + '\n');
  console.log(`Experiment started: ${entry.id}`);
  console.log(`  Hypothesis: ${exp.hypothesis}`);
  console.log(`  Runs from tick ${entry.start_tick} to ${entry.end_tick}`);
  console.log(`  Written to experiments.jsonl`);
}

main();
