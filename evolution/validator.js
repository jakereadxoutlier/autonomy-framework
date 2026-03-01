#!/usr/bin/env node
/**
 * Validator — Checks completed responses and writes experiment verdicts.
 *
 * 1. Reads responses/ for completed requests
 * 2. For each response, checks if mentioned files actually exist
 * 3. Runs any test commands mentioned in the response
 * 4. Writes a verdict to signals/experiments.jsonl
 * 5. If verdict is "failed", auto-rolls back from snapshots
 *
 * No dependencies. Pure Node.js.
 * Run: node evolution/validator.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AGENT_HOME_DIR = path.resolve(__dirname, '..');
const EVO = __dirname;
const RESPONSES = path.join(EVO, 'responses');
const REQUESTS = path.join(EVO, 'requests');
const SIGNALS = path.join(EVO, 'signals');
const SNAPSHOTS = path.join(EVO, 'snapshots');

const EXPERIMENTS_PATH = path.join(SIGNALS, 'experiments.jsonl');
const VALIDATION_STATE_PATH = path.join(SIGNALS, 'validation-state.json');

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

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function readDir(dirPath) {
  try { return fs.readdirSync(dirPath).filter(f => !f.startsWith('.')); }
  catch { return []; }
}

function fileExists(p) {
  try { fs.accessSync(p); return true; }
  catch { return false; }
}

function log(msg) {
  const line = `${new Date().toISOString()} [validator] ${msg}`;
  console.log(line);
}

// ── File Extraction ─────────────────────────────────────────────────────────

/**
 * Extract file paths mentioned in the response content.
 * Looks for patterns like:
 *   - ~/autonomy/path/to/file
 *   - evolution/path/to/file
 *   - Created: path/to/file
 *   - Files changed/created sections
 */
function extractMentionedFiles(content) {
  const files = new Set();

  // Match ~/autonomy/... paths
  const agentDir = path.basename(CLAWD);
  const homePathRegex = new RegExp(`~/${agentDir}/[\\w\\-./]+`, 'g');
  const homePaths = content.match(homePathRegex) || [];
  for (const p of homePaths) {
    const resolved = p.replace(`~/${agentDir}`, CLAWD);
    files.add(resolved);
  }

  // Match common relative paths under agent home
  const relativeDirs = ['evolution', 'garden', 'nerve', 'skills', 'scripts'];
  for (const dir of relativeDirs) {
    const regex = new RegExp(`(?:^|\\s)${dir}\\/[\\w\\-./]+`, 'gm');
    const matches = content.match(regex) || [];
    for (const p of matches) {
      files.add(path.join(CLAWD, p.trim()));
    }
  }

  // Filter: must look like actual files (have extension or known script names)
  const filtered = new Set();
  for (const f of files) {
    if (f.match(/\.\w{1,6}$/)) {
      filtered.add(f);
    }
  }

  return [...filtered];
}

/**
 * Extract test/verify commands from the response.
 * Looks for code blocks with shell commands after "verify" or "test" headers.
 * Returns parsed command arrays suitable for execFileSync.
 */
function extractTestCommands(content) {
  const commands = [];

  // Look for ```bash or ```sh blocks after Verify/Test headers
  const verifySection = content.match(/##?\s*(?:Verify|Test|How to (?:Test|Verify))[\s\S]*?```(?:bash|sh)\n([\s\S]*?)```/gi);
  if (verifySection) {
    for (const section of verifySection) {
      const codeMatch = section.match(/```(?:bash|sh)\n([\s\S]*?)```/);
      if (codeMatch) {
        const lines = codeMatch[1].trim().split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));
        commands.push(...lines);
      }
    }
  }

  return commands;
}

// ── Validation Logic ────────────────────────────────────────────────────────

/**
 * Parse a shell command string into [executable, ...args] for execFileSync.
 * Only handles simple commands (no pipes, redirects, etc.)
 */
function parseCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { bin: parts[0], args: parts.slice(1) };
}

/**
 * Safety check: only allow known-safe read-only executables.
 */
function isSafeCommand(cmd) {
  const { bin } = parseCommand(cmd);
  const safeBins = new Set([
    'node', 'ls', 'cat', 'head', 'tail', 'wc', 'file', 'test',
    'echo', 'stat', 'diff',
  ]);
  return safeBins.has(bin);
}

/**
 * Run a command safely using execFileSync (no shell injection possible).
 */
function runSafeCommand(cmd) {
  const { bin, args } = parseCommand(cmd);
  return execFileSync(bin, args, {
    cwd: CLAWD,
    timeout: 30000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function validateResponse(responseFile, responseContent, requestContent) {
  const checks = {
    files_mentioned: [],
    files_exist: [],
    files_missing: [],
    tests_run: [],
    tests_passed: [],
    tests_failed: [],
    overall: 'unknown',
  };

  // 1. Check mentioned files exist
  const mentioned = extractMentionedFiles(responseContent);
  checks.files_mentioned = mentioned.map(f => f.replace(CLAWD + '/', ''));

  for (const filePath of mentioned) {
    const relative = filePath.replace(CLAWD + '/', '');
    if (fileExists(filePath)) {
      checks.files_exist.push(relative);
    } else {
      checks.files_missing.push(relative);
    }
  }

  // 2. Run test commands (safely, using execFileSync — no shell injection)
  const testCommands = extractTestCommands(responseContent);

  for (const cmd of testCommands) {
    if (!isSafeCommand(cmd)) {
      log(`  Skipping non-allowlisted command: ${cmd}`);
      checks.tests_run.push({ cmd, status: 'skipped', reason: 'not in allowlist' });
      continue;
    }

    try {
      const output = runSafeCommand(cmd);
      checks.tests_passed.push(cmd);
      checks.tests_run.push({ cmd, status: 'passed', output: (output || '').slice(0, 200) });
      log(`  Test passed: ${cmd}`);
    } catch (err) {
      checks.tests_failed.push(cmd);
      checks.tests_run.push({
        cmd,
        status: 'failed',
        error: (err.stderr || err.message || '').slice(0, 200),
      });
      log(`  Test failed: ${cmd}`);
    }
  }

  // 3. Determine overall verdict
  const hasContent = responseContent.length > 100;
  const noMissing = checks.files_missing.length === 0;
  const noTestFailures = checks.tests_failed.length === 0;
  const hasFiles = checks.files_exist.length > 0;

  if (!hasContent) {
    checks.overall = 'failed';
  } else if (checks.files_missing.length > checks.files_exist.length) {
    checks.overall = 'failed';
  } else if (checks.tests_failed.length > 0) {
    checks.overall = 'partial';
  } else if (hasFiles && noMissing && noTestFailures) {
    checks.overall = 'success';
  } else {
    // Has content but couldn't verify files/tests — cautiously optimistic
    checks.overall = 'unverified';
  }

  return checks;
}

/**
 * Attempt rollback from snapshots for a failed response.
 */
function attemptRollback(responseContent) {
  const snapshotRefs = responseContent.match(/snapshots\/[\w\-./]+/g) || [];

  for (const ref of snapshotRefs) {
    const snapshotPath = path.join(EVO, ref);
    if (!fileExists(snapshotPath)) continue;

    // Derive the target file: snapshots/FILE.TIMESTAMP → FILE
    const basename = path.basename(ref);
    const targetMatch = basename.match(/^(.+?)\.\d{4}-\d{2}-\d{2}T\d{4}$/);
    if (!targetMatch) continue;

    const targetName = targetMatch[1];
    const targetPath = path.join(CLAWD, targetName);

    if (fileExists(targetPath)) {
      log(`  Rolling back ${targetName} from ${ref}`);
      fs.copyFileSync(snapshotPath, targetPath);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  log('Starting validation run');

  // Load state
  const validationState = readJson(VALIDATION_STATE_PATH) || { validated: {} };
  const existingExperiments = readJsonl(EXPERIMENTS_PATH);
  const existingIds = new Set(existingExperiments.map(e => e.id));

  // Get all response files
  const responseFiles = readDir(RESPONSES).filter(f => f.endsWith('.md'));

  let validated = 0;
  let skipped = 0;

  for (const file of responseFiles) {
    // Skip if already validated
    if (validationState.validated[file]) {
      skipped++;
      continue;
    }

    log(`Validating: ${file}`);

    const responseContent = fs.readFileSync(path.join(RESPONSES, file), 'utf-8');

    // Read matching request if it exists
    let requestContent = '';
    const requestPath = path.join(REQUESTS, file);
    if (fileExists(requestPath)) {
      requestContent = fs.readFileSync(requestPath, 'utf-8');
    }

    // Run validation
    const checks = validateResponse(file, responseContent, requestContent);

    // Generate experiment ID
    const expId = `exp-auto-${file.replace(/\.md$/, '').replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`;

    // Don't duplicate experiment entries
    if (existingIds.has(expId)) {
      log(`  Experiment ${expId} already exists, skipping`);
      validationState.validated[file] = {
        validated_at: new Date().toISOString(),
        verdict: 'already-tracked',
      };
      skipped++;
      continue;
    }

    // Extract gap signature from request if present
    let gapSignature = '';
    const sigMatch = requestContent.match(/\*\*Gap signature:\*\*\s*(.+)/);
    if (sigMatch) gapSignature = sigMatch[1].trim();

    // Write experiment entry
    const experiment = {
      id: expId,
      proposal: file.replace(/\.md$/, ''),
      applied: new Date().toISOString(),
      signal: gapSignature || file,
      status: checks.overall === 'success' ? 'success' :
              checks.overall === 'failed' ? 'failed' :
              'measuring',
      verdict: checks.overall,
      validation: {
        files_exist: checks.files_exist.length,
        files_missing: checks.files_missing.length,
        tests_passed: checks.tests_passed.length,
        tests_failed: checks.tests_failed.length,
      },
      window_hours: 48,
      target: file,
    };

    appendJsonl(EXPERIMENTS_PATH, experiment);
    existingIds.add(expId);
    log(`  Verdict: ${checks.overall} (${checks.files_exist.length} files ok, ${checks.files_missing.length} missing, ${checks.tests_passed.length}/${checks.tests_run.length} tests passed)`);

    // If failed, attempt rollback
    if (checks.overall === 'failed') {
      log(`  Attempting rollback for failed response: ${file}`);
      attemptRollback(responseContent);
    }

    // Update state
    validationState.validated[file] = {
      validated_at: new Date().toISOString(),
      verdict: checks.overall,
      checks_summary: {
        files_exist: checks.files_exist.length,
        files_missing: checks.files_missing.length,
        tests_passed: checks.tests_passed.length,
        tests_failed: checks.tests_failed.length,
      },
    };

    validated++;
  }

  // Save state
  validationState.last_run = new Date().toISOString();
  writeJson(VALIDATION_STATE_PATH, validationState);

  log(`Done. Validated ${validated} response(s), skipped ${skipped} already-validated.`);
}

main();
