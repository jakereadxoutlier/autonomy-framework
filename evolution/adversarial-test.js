#!/usr/bin/env node
// Adversarial self-testing: run edge cases against all scripts
// Run: node adversarial-test.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = path.join(__dirname, '..');
const DIRS = ['evolution', 'nerve', 'garden'].map(d => path.join(BASE, d));
const RESULTS_FILE = path.join(__dirname, 'signals', 'adversarial-results.jsonl');
const TMP = path.join(__dirname, '.adversarial-tmp');

// Scripts to skip (they're daemons or have side effects)
const SKIP = ['bridge-daemon.js', 'daemon.js', 'dashboard-server.js', 'adversarial-test.js', 'install.sh'];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function collectScripts() {
  const scripts = [];
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js') && !SKIP.includes(f)) {
        scripts.push({ name: f, full: path.join(dir, f), dir: path.basename(dir) });
      }
    }
  }
  return scripts;
}

function generateEdgeCases() {
  ensureDir(TMP);
  const cases = [];

  // Empty file
  const empty = path.join(TMP, 'empty.json');
  fs.writeFileSync(empty, '');
  cases.push({ name: 'empty file', file: empty, env: {} });

  // Malformed JSON
  const bad = path.join(TMP, 'malformed.json');
  fs.writeFileSync(bad, '{not json at all!!!');
  cases.push({ name: 'malformed JSON', file: bad, env: {} });

  // Extremely long input
  const long = path.join(TMP, 'long.json');
  fs.writeFileSync(long, JSON.stringify({ data: 'x'.repeat(100000) }));
  cases.push({ name: 'extremely long input', file: long, env: {} });

  // Missing fields
  const missing = path.join(TMP, 'missing-fields.json');
  fs.writeFileSync(missing, '{}');
  cases.push({ name: 'missing required fields', file: missing, env: {} });

  // Empty JSONL
  const emptyJsonl = path.join(TMP, 'empty.jsonl');
  fs.writeFileSync(emptyJsonl, '');
  cases.push({ name: 'empty .jsonl', file: emptyJsonl, env: {} });

  // Malformed JSONL
  const badJsonl = path.join(TMP, 'bad.jsonl');
  fs.writeFileSync(badJsonl, 'not json\n{also bad\n');
  cases.push({ name: 'malformed .jsonl', file: badJsonl, env: {} });

  return cases;
}

function runTest(script, testCase) {
  const timeout = 10000; // 10s max
  try {
    execSync(`node "${script.full}" 2>&1`, {
      timeout,
      env: { ...process.env, ...testCase.env, ADVERSARIAL_TEST: '1' },
      cwd: path.dirname(script.full),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024
    });
    return { result: 'ok', error: null, severity: 'none' };
  } catch (err) {
    const stderr = (err.stderr || err.stdout || '').toString().slice(0, 500);
    const isTimeout = err.killed;
    const isCrash = stderr.includes('Error') || stderr.includes('TypeError') || stderr.includes('Cannot');
    return {
      result: isTimeout ? 'timeout' : (isCrash ? 'crash' : 'error'),
      error: stderr || err.message,
      severity: isTimeout ? 'medium' : (isCrash ? 'high' : 'low')
    };
  }
}

function main() {
  const scripts = collectScripts();
  const cases = generateEdgeCases();
  ensureDir(path.dirname(RESULTS_FILE));

  console.log(`Testing ${scripts.length} scripts with ${cases.length} edge cases...`);
  let total = 0, failures = 0;

  for (const script of scripts) {
    for (const tc of cases) {
      total++;
      const result = runTest(script, tc);
      if (result.result !== 'ok') {
        failures++;
        const entry = {
          ts: new Date().toISOString(),
          script: script.name,
          dir: script.dir,
          test: tc.name,
          result: result.result,
          error: result.error,
          severity: result.severity
        };
        fs.appendFileSync(RESULTS_FILE, JSON.stringify(entry) + '\n');
        console.log(`  ✗ ${script.dir}/${script.name} — ${tc.name}: ${result.result} (${result.severity})`);
      }
    }
  }

  // Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\nDone: ${total} tests, ${failures} failures logged to signals/adversarial-results.jsonl`);
}

main();
