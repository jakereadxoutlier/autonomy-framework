#!/usr/bin/env node
/**
 * Prediction-Error Tracking Engine v1
 *
 * Each evolution tick predicts what the next tick will observe,
 * then the next tick compares predictions vs reality and logs errors.
 *
 * Usage:
 *   node prediction-engine.js predict   — snapshot state, write predictions
 *   node prediction-engine.js evaluate  — compare predictions to reality, log errors
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const EVO = path.join(BASE, 'evolution');
const PRED_DIR = path.join(EVO, 'predictions');
const PREDICTIONS_FILE = path.join(PRED_DIR, 'tick-predictions.json');
const ERROR_LOG = path.join(PRED_DIR, 'error-log.jsonl');
const PRECISION_FILE = path.join(PRED_DIR, 'precision.json');

// Key directories to monitor
const MONITORED_DIRS = {
  requests: path.join(EVO, 'requests'),
  responses: path.join(EVO, 'responses'),
  subagent_outputs: path.join(EVO, 'signals/subagent-outputs/processed'),
  signals: path.join(EVO, 'signals'),
  nerve: path.join(BASE, 'nerve'),
  garden: path.join(BASE, 'garden'),
};

const MONITORED_FILES = {
  tick_journal: path.join(EVO, 'tick-journal.md'),
  memory: path.join(BASE, 'MEMORY.md'),
  soul: path.join(BASE, 'SOUL.md'),
};

// --- Helpers ---

function dirFileCount(dirPath) {
  try {
    return fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).length;
  } catch { return 0; }
}

function fileMtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; }
  catch { return 0; }
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; }
  catch { return 0; }
}

function pendingRequestCount() {
  try {
    const files = fs.readdirSync(MONITORED_DIRS.requests).filter(f => f.endsWith('.md'));
    let pending = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(MONITORED_DIRS.requests, f), 'utf8');
      if (content.includes('Status:** pending') || content.includes('Status:** in-progress')) pending++;
    }
    return pending;
  } catch { return 0; }
}

function recentJournalEntries(count) {
  try {
    const journal = fs.readFileSync(MONITORED_FILES.tick_journal, 'utf8');
    const entries = journal.split(/^## Tick /m).slice(1, count + 1);
    return entries.map(e => {
      const lines = e.trim().split('\n');
      const header = lines[0] || '';
      const tickMatch = header.match(/^(\d+)\s*-\s*(.+)/);
      return {
        tick: tickMatch ? parseInt(tickMatch[1]) : 0,
        header: header.slice(0, 120),
        hasDispatched: e.includes('Dispatched') || e.includes('dispatched') || e.includes('subagent'),
        hasBridge: e.includes('bridge') || e.includes('Bridge'),
        lineCount: lines.length,
      };
    });
  } catch { return []; }
}

function recentTickLog(count) {
  try {
    const lines = fs.readFileSync(path.join(EVO, 'signals/tick-log.jsonl'), 'utf8')
      .trim().split('\n').slice(-count);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// --- Snapshot ---

function snapshotState() {
  const dirCounts = {};
  for (const [name, dir] of Object.entries(MONITORED_DIRS)) {
    dirCounts[name] = dirFileCount(dir);
  }

  const fileTimes = {};
  const fileSizes = {};
  for (const [name, fp] of Object.entries(MONITORED_FILES)) {
    fileTimes[name] = fileMtime(fp);
    fileSizes[name] = fileSize(fp);
  }

  return {
    timestamp: new Date().toISOString(),
    dir_counts: dirCounts,
    file_mtimes: fileTimes,
    file_sizes: fileSizes,
    pending_requests: pendingRequestCount(),
    recent_ticks: recentTickLog(3),
  };
}

// --- Predict Mode ---

function runPredict() {
  const state = snapshotState();
  const recentEntries = recentJournalEntries(3);
  const ticks = recentTickLog(5);

  // Predict file count deltas using recent tick patterns
  const dirPredictions = {};
  for (const [name, count] of Object.entries(state.dir_counts)) {
    // Default: expect stability (+0), but if requests/responses trend up, predict +1
    let expectedDelta = 0;
    if (name === 'requests' && state.pending_requests > 0) expectedDelta = 1;
    if (name === 'subagent_outputs') {
      // If recent ticks dispatched subagents, expect outputs
      const recentDispatches = ticks.filter(t =>
        t.dispatched || t.subagents_spawned || t.subagent_outputs_processed
      ).length;
      expectedDelta = recentDispatches > 0 ? 2 : 0;
    }
    if (name === 'responses') {
      expectedDelta = state.pending_requests > 0 ? 1 : 0;
    }
    dirPredictions[name] = {
      current: count,
      predicted: count + expectedDelta,
      expected_delta: expectedDelta,
    };
  }

  // Predict which files will change
  const filePredictions = {};
  for (const [name, mtime] of Object.entries(state.file_mtimes)) {
    // Journal and memory almost always change each tick
    const likelyChanges = name === 'tick_journal' || name === 'memory';
    filePredictions[name] = {
      will_change: likelyChanges,
      current_size: state.file_sizes[name],
      predicted_growth: likelyChanges ? Math.round(state.file_sizes[name] * 0.02) : 0,
    };
  }

  // Bridge activity prediction
  const bridgePrediction = {
    expected_new_requests: ticks.length > 0 ? Math.round(
      ticks.reduce((s, t) => s + (t.dispatched ? (Array.isArray(t.dispatched) ? t.dispatched.length : 1) : 0), 0) / Math.max(1, ticks.length)
    ) : 1,
    expected_responses: state.pending_requests > 0 ? 1 : 0,
  };

  // Subagent prediction
  const subagentPrediction = {
    expected_outputs: ticks.filter(t => t.dispatched || t.subagents_spawned).length > 0 ? 2 : 0,
  };

  // Narrative prediction based on recent frontier patterns
  const recentFrontiers = ticks.map(t => t.frontier).filter(Boolean);
  const narrativePrediction = recentFrontiers.length > 0
    ? `Likely continues integrating research from recent frontiers: ${recentFrontiers.slice(0, 2).join(', ')}. Will probably dispatch new subagents for next research cycle.`
    : 'Insufficient tick history for narrative prediction.';

  const predictions = {
    generated_at: new Date().toISOString(),
    state_snapshot: state,
    predictions: {
      dir_counts: dirPredictions,
      file_changes: filePredictions,
      bridge: bridgePrediction,
      subagents: subagentPrediction,
      narrative: narrativePrediction,
    },
  };

  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(predictions, null, 2));
  console.log('=== Predictions Written ===');
  console.log(`Timestamp: ${predictions.generated_at}`);
  for (const [k, v] of Object.entries(dirPredictions)) {
    console.log(`  ${k}: ${v.current} → ${v.predicted} (delta: ${v.expected_delta >= 0 ? '+' : ''}${v.expected_delta})`);
  }
  console.log(`  Bridge: expect ${bridgePrediction.expected_new_requests} new requests, ${bridgePrediction.expected_responses} responses`);
  console.log(`  Subagents: expect ${subagentPrediction.expected_outputs} outputs`);
  console.log(`  Narrative: ${narrativePrediction.slice(0, 100)}...`);
}

// --- Evaluate Mode ---

function runEvaluate() {
  let predictions;
  try {
    predictions = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
  } catch {
    console.log('No predictions file found. Run `predict` first.');
    process.exit(1);
  }

  const currentState = snapshotState();
  const pred = predictions.predictions;
  const errors = {};
  let totalScore = 0;
  let totalChecks = 0;

  // Evaluate dir count predictions
  errors.dir_counts = {};
  for (const [name, p] of Object.entries(pred.dir_counts)) {
    const actual = currentState.dir_counts[name] || 0;
    const diff = Math.abs(actual - p.predicted);
    const maxVal = Math.max(1, actual, p.predicted);
    const accuracy = 1 - (diff / maxVal);
    errors.dir_counts[name] = {
      predicted: p.predicted,
      actual,
      diff,
      accuracy: Math.max(0, accuracy),
    };
    totalScore += Math.max(0, accuracy);
    totalChecks++;
  }

  // Evaluate file change predictions
  errors.file_changes = {};
  for (const [name, p] of Object.entries(pred.file_changes)) {
    const currentMtime = currentState.file_mtimes[name] || 0;
    const prevMtime = predictions.state_snapshot.file_mtimes[name] || 0;
    const didChange = currentMtime > prevMtime;
    const changeCorrect = p.will_change === didChange;
    errors.file_changes[name] = {
      predicted_change: p.will_change,
      actual_change: didChange,
      correct: changeCorrect,
    };
    totalScore += changeCorrect ? 1 : 0;
    totalChecks++;
  }

  // Evaluate bridge predictions
  const prevReqCount = predictions.state_snapshot.dir_counts.requests || 0;
  const curReqCount = currentState.dir_counts.requests || 0;
  const newRequests = Math.max(0, curReqCount - prevReqCount);
  const prevResCount = predictions.state_snapshot.dir_counts.responses || 0;
  const curResCount = currentState.dir_counts.responses || 0;
  const newResponses = Math.max(0, curResCount - prevResCount);

  errors.bridge = {
    predicted_requests: pred.bridge.expected_new_requests,
    actual_requests: newRequests,
    request_accuracy: 1 - Math.min(1, Math.abs(newRequests - pred.bridge.expected_new_requests) / Math.max(1, newRequests, pred.bridge.expected_new_requests)),
    predicted_responses: pred.bridge.expected_responses,
    actual_responses: newResponses,
    response_accuracy: 1 - Math.min(1, Math.abs(newResponses - pred.bridge.expected_responses) / Math.max(1, newResponses, pred.bridge.expected_responses)),
  };
  totalScore += errors.bridge.request_accuracy + errors.bridge.response_accuracy;
  totalChecks += 2;

  // Evaluate subagent predictions
  const prevSubCount = predictions.state_snapshot.dir_counts.subagent_outputs || 0;
  const curSubCount = currentState.dir_counts.subagent_outputs || 0;
  const newOutputs = Math.max(0, curSubCount - prevSubCount);
  errors.subagents = {
    predicted_outputs: pred.subagents.expected_outputs,
    actual_outputs: newOutputs,
    accuracy: 1 - Math.min(1, Math.abs(newOutputs - pred.subagents.expected_outputs) / Math.max(1, newOutputs, pred.subagents.expected_outputs)),
  };
  totalScore += errors.subagents.accuracy;
  totalChecks++;

  const overallAccuracy = totalChecks > 0 ? totalScore / totalChecks : 0;

  // Append to error log
  const logEntry = {
    timestamp: new Date().toISOString(),
    prediction_time: predictions.generated_at,
    overall_accuracy: overallAccuracy,
    errors,
  };
  fs.appendFileSync(ERROR_LOG, JSON.stringify(logEntry) + '\n');

  // Update precision.json
  updatePrecision(errors, overallAccuracy);

  // Print summary
  const summary = [
    `=== Prediction Evaluation ===`,
    `Predicted at: ${predictions.generated_at}`,
    `Evaluated at: ${logEntry.timestamp}`,
    `Overall accuracy: ${(overallAccuracy * 100).toFixed(1)}%`,
    ``,
    `Dir counts:`,
    ...Object.entries(errors.dir_counts).map(([k, v]) =>
      `  ${k}: predicted=${v.predicted} actual=${v.actual} ${v.diff === 0 ? '✓' : `✗ (off by ${v.diff})`}`
    ),
    `File changes:`,
    ...Object.entries(errors.file_changes).map(([k, v]) =>
      `  ${k}: predicted_change=${v.predicted_change} actual=${v.actual_change} ${v.correct ? '✓' : '✗'}`
    ),
    `Bridge: requests ${errors.bridge.actual_requests}/${errors.bridge.predicted_requests}, responses ${errors.bridge.actual_responses}/${errors.bridge.predicted_responses}`,
    `Subagents: outputs ${errors.subagents.actual_outputs}/${errors.subagents.predicted_outputs}`,
  ];

  const summaryStr = summary.join('\n');
  console.log(summaryStr);
  return summaryStr;
}

function updatePrecision(errors, overallAccuracy) {
  let precision;
  try {
    precision = JSON.parse(fs.readFileSync(PRECISION_FILE, 'utf8'));
  } catch {
    precision = { sources: {}, global_accuracy: 0.5, total_evaluations: 0 };
  }

  const lr = 0.1; // learning rate for trust updates

  // Update per-source trust
  const dirAcc = Object.values(errors.dir_counts).reduce((s, v) => s + v.accuracy, 0) /
    Math.max(1, Object.keys(errors.dir_counts).length);
  updateSource(precision, 'file_counts', dirAcc, lr);

  updateSource(precision, 'bridge_activity',
    (errors.bridge.request_accuracy + errors.bridge.response_accuracy) / 2, lr);

  updateSource(precision, 'subagent_outputs', errors.subagents.accuracy, lr);

  const journalCorrect = errors.file_changes.tick_journal?.correct ? 1 : 0;
  updateSource(precision, 'journal_growth', journalCorrect, lr);

  // Nerve activity — based on nerve dir count accuracy
  const nerveAcc = errors.dir_counts.nerve?.accuracy || 0.5;
  updateSource(precision, 'nerve_activity', nerveAcc, lr);

  precision.global_accuracy = precision.global_accuracy * (1 - lr) + overallAccuracy * lr;
  precision.total_evaluations++;
  precision.last_updated = new Date().toISOString();

  fs.writeFileSync(PRECISION_FILE, JSON.stringify(precision, null, 2));
}

function updateSource(precision, name, accuracy, lr) {
  if (!precision.sources[name]) {
    precision.sources[name] = { trust: 0.5, evaluations: 0 };
  }
  const src = precision.sources[name];
  src.trust = src.trust * (1 - lr) + accuracy * lr;
  src.evaluations++;
}

// --- Main ---

const cmd = process.argv[2];
if (cmd === 'predict') {
  runPredict();
} else if (cmd === 'evaluate') {
  runEvaluate();
} else {
  console.log('Usage: node prediction-engine.js [predict|evaluate]');
  process.exit(1);
}
