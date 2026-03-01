#!/usr/bin/env node
/**
 * evolution/gap-builder.js — Reads failures, generates bridge requests
 *
 * Scans signals/failures.jsonl for entries with severity >= 4
 * that haven't been addressed yet (no matching request or experiment).
 * Generates .md request files in requests/ for the bridge daemon.
 *
 * No npm dependencies. Pure Node.js.
 *
 * Usage:
 *   node evolution/gap-builder.js           # normal run
 *   node evolution/gap-builder.js --dry-run # show what would be generated
 */

var fs = require('fs');
var path = require('path');

var EVO_DIR = path.resolve(__dirname);
var SIGNALS_DIR = path.join(EVO_DIR, 'signals');
var REQUESTS_DIR = path.join(EVO_DIR, 'requests');
var RESPONSES_DIR = path.join(EVO_DIR, 'responses');

var FAILURES_PATH = path.join(SIGNALS_DIR, 'failures.jsonl');
var EXPERIMENTS_PATH = path.join(SIGNALS_DIR, 'experiments.jsonl');

var SEVERITY_THRESHOLD = 4;
var DRY_RUN = process.argv.includes('--dry-run');

// ── Helpers ──────────────────────────────────────────────────

function readJsonl(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(function(line) {
      try { return JSON.parse(line); }
      catch(e) { return null; }
    }).filter(Boolean);
  } catch(e) { return []; }
}

function listMdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(function(f) { return f.endsWith('.md'); });
  } catch(e) { return []; }
}

function log(msg) {
  console.log('[gap-builder] ' + msg);
}

// Build a fingerprint from a failure entry for dedup
function fingerprint(entry) {
  var detail = (entry.detail || '').toLowerCase();
  // Extract key words (>3 chars) for fuzzy matching
  var words = detail.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(function(w) {
    return w.length > 3;
  }).slice(0, 6);
  return (entry.type || 'unknown') + ':' + words.join('_');
}

// Check if a fingerprint matches anything in existing requests/responses/experiments
function isAlreadyAddressed(fp, existingFingerprints) {
  // Exact match
  if (existingFingerprints.has(fp)) return true;

  // Fuzzy: check if the key words overlap significantly
  var fpParts = fp.split(':');
  var fpWords = (fpParts[1] || '').split('_');

  for (var existing of existingFingerprints) {
    var exParts = existing.split(':');
    var exWords = (exParts[1] || '').split('_');

    // Same type, >50% word overlap = probably same gap
    if (fpParts[0] === exParts[0]) {
      var overlap = fpWords.filter(function(w) { return exWords.indexOf(w) >= 0; }).length;
      var minLen = Math.min(fpWords.length, exWords.length);
      if (minLen > 0 && overlap / minLen > 0.5) return true;
    }
  }

  return false;
}

// Generate a request filename
function makeFilename(entry) {
  var now = new Date();
  var ts = now.toISOString().replace(/[-:]/g, '').slice(0, 13); // 20260228T0742
  var slug = (entry.detail || entry.type || 'gap')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 35);
  return ts + '-gap-' + slug + '.md';
}

// Map severity to priority label
function severityToPriority(sev) {
  if (sev >= 5) return 'P0-urgent';
  if (sev >= 4) return 'P1-high';
  if (sev >= 3) return 'P2-normal';
  return 'P3-low';
}

// Map failure type to request type
function failureTypeToRequestType(type) {
  var map = {
    'capability_gap': 'capability-gap',
    'task_failure': 'bug-fix',
    'tool_error': 'bug-fix',
    'user_correction': 'refactor',
    'pattern': 'architecture'
  };
  return map[type] || 'capability-gap';
}

// Generate request markdown
function generateRequestMd(entry, fp) {
  var title = entry.detail ? entry.detail.slice(0, 80) : 'Unresolved gap';
  var priority = severityToPriority(entry.severity);
  var reqType = failureTypeToRequestType(entry.type);

  return [
    '# Request: ' + title,
    '- **From:** gap-builder (auto-generated)',
    '- **Priority:** ' + priority,
    '- **Type:** ' + reqType,
    '- **Status:** pending',
    '- **Gap fingerprint:** ' + fp,
    '',
    '## Context',
    'Auto-generated from failure signal detected in `signals/failures.jsonl`.',
    '',
    '**Original signal:**',
    '```json',
    JSON.stringify(entry, null, 2),
    '```',
    '',
    entry.frequency ? '**Frequency:** ' + entry.frequency : '',
    entry.source ? '**Source:** ' + entry.source : '',
    '',
    '## Desired Outcome',
    'Resolve this capability gap so the failure does not recur.',
    '',
    '## Acceptance Criteria',
    '1. The root cause is addressed',
    '2. New/modified files are functional (not stubs)',
    '3. An experiment entry is logged to track whether the fix works',
    ''
  ].filter(function(line) { return line !== undefined; }).join('\n');
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  log('Starting gap analysis...');
  if (DRY_RUN) log('(DRY RUN — no files will be written)');

  // Ensure dirs exist
  [SIGNALS_DIR, REQUESTS_DIR].forEach(function(d) {
    fs.mkdirSync(d, { recursive: true });
  });

  // Load data
  var failures = readJsonl(FAILURES_PATH);
  var experiments = readJsonl(EXPERIMENTS_PATH);

  log('Loaded ' + failures.length + ' failure signals, ' + experiments.length + ' experiments');

  // Build set of already-addressed fingerprints
  var addressed = new Set();

  // From experiments (measuring or success = addressed)
  experiments.forEach(function(exp) {
    if (exp.status === 'measuring' || exp.status === 'success') {
      if (exp.proposal) addressed.add(exp.proposal);
      if (exp.signal) addressed.add(exp.signal);
    }
  });

  // From existing request files (read their fingerprints)
  listMdFiles(REQUESTS_DIR).forEach(function(f) {
    try {
      var content = fs.readFileSync(path.join(REQUESTS_DIR, f), 'utf-8');
      var fpMatch = content.match(/\*\*Gap fingerprint:\*\*\s*(.+)/);
      if (fpMatch) addressed.add(fpMatch[1].trim());
    } catch(e) { /* skip unreadable files */ }
  });

  // From existing response files (completed work)
  listMdFiles(RESPONSES_DIR).forEach(function(f) {
    addressed.add(f.replace('.md', ''));
  });

  log('Found ' + addressed.size + ' already-addressed items');

  // Filter to actionable gaps
  var actionable = failures.filter(function(entry) {
    // Must meet severity threshold
    if ((entry.severity || 0) < SEVERITY_THRESHOLD) return false;

    // Skip insights (informational, not failures)
    if (entry.type === 'insight') return false;

    // Check if already addressed
    var fp = fingerprint(entry);
    if (isAlreadyAddressed(fp, addressed)) {
      log('  SKIP (addressed): ' + fp);
      return false;
    }

    return true;
  });

  log('Found ' + actionable.length + ' unresolved gaps (severity >= ' + SEVERITY_THRESHOLD + ')');

  if (actionable.length === 0) {
    log('No new gaps to process. System is clean.');
    return;
  }

  // Generate requests
  var generated = 0;
  actionable.forEach(function(entry) {
    var fp = fingerprint(entry);
    var filename = makeFilename(entry);
    var content = generateRequestMd(entry, fp);

    if (DRY_RUN) {
      log('  WOULD GENERATE: ' + filename);
      log('    Fingerprint: ' + fp);
      log('    Detail: ' + (entry.detail || '').slice(0, 80));
    } else {
      var outPath = path.join(REQUESTS_DIR, filename);
      fs.writeFileSync(outPath, content);
      log('  GENERATED: ' + filename);

      // Add to addressed set so we don't generate duplicates in same run
      addressed.add(fp);
    }

    generated++;
  });

  log('Done. ' + (DRY_RUN ? 'Would generate' : 'Generated') + ' ' + generated + ' request(s).');
}

main();
