#!/usr/bin/env node

// frontier-roi.js — Calculate ROI per frontier from tick-journal.md

const fs = require('fs');
const path = require('path');

const EVOLUTION = path.resolve(__dirname, '..');
const JOURNAL = path.join(EVOLUTION, 'tick-journal.md');
const RESPONSES = path.join(EVOLUTION, 'responses');
const OUTPUT = path.join(__dirname, 'frontier-scores.json');

// Parse tick-journal.md into entries
function parseJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  const content = fs.readFileSync(JOURNAL, 'utf8');
  const entries = [];
  // Split by ## headers (tick entries)
  const sections = content.split(/^## /m).filter(Boolean);
  for (const sec of sections) {
    const lines = sec.split('\n');
    const header = lines[0] || '';
    const body = lines.slice(1).join('\n');
    
    // Extract frontier from body
    const frontierMatch = body.match(/[Ff]rontier[:\s]+([^\n,]+)/i) || 
                          body.match(/\*\*[Ff]rontier\*\*[:\s]+([^\n,]+)/i);
    const frontier = frontierMatch ? frontierMatch[1].trim().replace(/\*+/g, '') : 'unknown';
    
    // Count seeds planted
    const seedMatches = body.match(/seed|plant/gi) || [];
    const seedCount = seedMatches.length > 0 ? 1 : 0;
    
    // Count build requests
    const buildMatches = body.match(/build|request|bridge/gi) || [];
    const buildCount = buildMatches.length > 0 ? 1 : 0;
    
    entries.push({ header, frontier, seedCount, buildCount });
  }
  return entries;
}

// Count working responses
function countWorkingResponses() {
  if (!fs.existsSync(RESPONSES)) return 0;
  const files = fs.readdirSync(RESPONSES).filter(f => f.endsWith('.md'));
  let working = 0;
  for (const f of files) {
    const content = fs.readFileSync(path.join(RESPONSES, f), 'utf8');
    if (/status.*completed|status.*success|working/i.test(content)) working++;
  }
  return working;
}

// Main
const entries = parseJournal();
const workingTotal = countWorkingResponses();

// Group by frontier
const frontiers = {};
for (const e of entries) {
  if (!frontiers[e.frontier]) {
    frontiers[e.frontier] = { ticks: 0, seeds: 0, builds: 0 };
  }
  frontiers[e.frontier].ticks++;
  frontiers[e.frontier].seeds += e.seedCount;
  frontiers[e.frontier].builds += e.buildCount;
}

// Calculate ROI and flag dead ends
const results = {};
const rows = [];
for (const [name, data] of Object.entries(frontiers)) {
  // Distribute working builds proportionally
  const totalBuilds = Object.values(frontiers).reduce((s, f) => s + f.builds, 0);
  const workingBuilds = totalBuilds > 0 ? Math.round(workingTotal * (data.builds / totalBuilds)) : 0;
  
  const roi = data.ticks > 0 ? (workingBuilds + data.seeds) / data.ticks : 0;
  const status = (roi < 0.1 && data.ticks >= 5) ? 'DEAD END — consider pivoting' : 'active';
  
  results[name] = { ticks: data.ticks, seeds: data.seeds, builds: data.builds, workingBuilds, roi: Math.round(roi * 100) / 100, status };
  rows.push({ name, ...results[name] });
}

// Write JSON
fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2));

// Print table
console.log('\n┌─────────────────────────────┬───────┬───────┬────────┬─────────┬───────┬──────────────────────────────┐');
console.log('│ Frontier                    │ Ticks │ Seeds │ Builds │ Working │  ROI  │ Status                       │');
console.log('├─────────────────────────────┼───────┼───────┼────────┼─────────┼───────┼──────────────────────────────┤');
for (const r of rows) {
  const n = r.name.padEnd(27).slice(0, 27);
  const t = String(r.ticks).padStart(5);
  const s = String(r.seeds).padStart(5);
  const b = String(r.builds).padStart(6);
  const w = String(r.workingBuilds).padStart(7);
  const roi = r.roi.toFixed(2).padStart(5);
  const st = r.status.padEnd(28).slice(0, 28);
  console.log(`│ ${n} │ ${t} │ ${s} │ ${b} │ ${w} │ ${roi} │ ${st} │`);
}
console.log('└─────────────────────────────┴───────┴───────┴────────┴─────────┴───────┴──────────────────────────────┘');
console.log(`\nResults written to ${OUTPUT}`);
