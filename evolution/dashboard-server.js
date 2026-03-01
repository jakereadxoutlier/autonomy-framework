#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 7888;
const BASE = path.resolve(__dirname, '..');
const EVO = __dirname;

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }
function countDir(d) { try { return fs.readdirSync(d).length; } catch { return 0; } }

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function lastNTicks(journal, n) {
  const ticks = journal.split(/(?=^## Tick \d)/m).filter(t => t.startsWith('## Tick'));
  return ticks.slice(-n).join('\n');
}

function buildPage() {
  const state = read(path.join(EVO, 'STATE.md'));
  const journal = read(path.join(EVO, 'tick-journal.md'));
  const gardenStatus = read(path.join(BASE, 'garden', 'STATUS.md'));
  const frontier = read(path.join(EVO, 'signals', 'frontier-scores.json'));
  const pendingReqs = countDir(path.join(EVO, 'requests'));
  const completedReqs = countDir(path.join(EVO, 'responses'));

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Evolution Dashboard</title>
<meta http-equiv="refresh" content="60">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:'Courier New',monospace;font-size:14px;padding:20px}
h1{color:#58a6ff;margin-bottom:20px;font-size:20px}
h2{color:#79c0ff;margin:16px 0 8px;font-size:16px;border-bottom:1px solid #21262d;padding-bottom:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;overflow:auto;max-height:400px}
pre{white-space:pre-wrap;word-wrap:break-word;font-size:13px}
.stat{color:#3fb950;font-weight:bold}
.label{color:#8b949e}
</style></head><body>
<h1>🧬 Evolution Dashboard</h1>
<div class="grid">
<div class="panel"><h2>STATE.md</h2><pre>${escHtml(state || 'No STATE.md found')}</pre></div>
<div class="panel"><h2>Garden Status</h2><pre>${escHtml(gardenStatus || 'No garden STATUS.md')}</pre></div>
<div class="panel"><h2>Last 10 Ticks</h2><pre>${escHtml(lastNTicks(journal, 10) || 'No ticks yet')}</pre></div>
<div class="panel"><h2>Frontier Scores</h2><pre>${escHtml(frontier || '{}')}</pre></div>
</div>
<div class="panel" style="margin-top:16px">
<h2>Bridge Queue</h2>
<p><span class="label">Pending requests:</span> <span class="stat">${pendingReqs}</span> | 
<span class="label">Completed responses:</span> <span class="stat">${completedReqs}</span></p>
</div>
<p style="color:#484f58;margin-top:16px;font-size:12px">Auto-refreshes every 60s | ${new Date().toISOString()}</p>
</body></html>`;
}

http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end(buildPage());
}).listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));
