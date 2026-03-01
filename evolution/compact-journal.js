#!/usr/bin/env node
/**
 * Compact tick-journal.md — keeps last 50 entries, archives older ones by week.
 * Run: node compact-journal.js
 */
const fs = require('fs');
const path = require('path');

const JOURNAL = path.join(__dirname, 'tick-journal.md');
const ARCHIVE_DIR = path.join(__dirname, 'journal-archive');

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const content = fs.readFileSync(JOURNAL, 'utf8');
// Split on ## entries (each tick starts with ## YYYY-MM-DD or ## Tick)
const parts = content.split(/^(## \d{4}-\d{2}-\d{2}.*)/m);

// Reconstruct entries: parts[0] is header, then alternating [heading, body]
const header = parts[0];
const entries = [];
for (let i = 1; i < parts.length; i += 2) {
  entries.push({ heading: parts[i], body: parts[i + 1] || '' });
}

if (entries.length <= 50) {
  console.log(`Only ${entries.length} entries, nothing to compact.`);
  process.exit(0);
}

const keep = entries.slice(-50);
const archive = entries.slice(0, -50);

// Group archived entries by ISO week
const byWeek = {};
for (const e of archive) {
  const match = e.heading.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) continue;
  const d = new Date(match[1]);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  (byWeek[key] = byWeek[key] || []).push(e);
}

// Write weekly archive files
for (const [week, ents] of Object.entries(byWeek)) {
  const archFile = path.join(ARCHIVE_DIR, `${week}.md`);
  let existing = '';
  try { existing = fs.readFileSync(archFile, 'utf8'); } catch {}
  const summary = ents.map(e => `${e.heading}\n${e.body}`).join('\n');
  fs.writeFileSync(archFile, existing + summary);
  console.log(`Archived ${ents.length} entries to ${week}.md`);
}

// Rewrite journal with header + last 50
const newHeader = `<!-- Compacted weekly. Archive at journal-archive/ -->\n`;
const newContent = newHeader + header.replace(/^<!--.*?-->\n?/m, '') +
  keep.map(e => `${e.heading}${e.body}`).join('');
fs.writeFileSync(JOURNAL, newContent);
console.log(`Compacted: kept ${keep.length}, archived ${archive.length}`);
