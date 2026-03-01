#!/usr/bin/env node

// garden-tender.js — Tends the Knowledge Garden
// Promotes, composts, and generates STATUS.md
// Run: node garden/garden-tender.js

const fs = require('fs');
const path = require('path');

const GARDEN = path.resolve(__dirname);
const STAGES = ['seeds', 'growing', 'mature', 'compost'];
const STALE_DAYS = 14;
const STALE_WARNING_DAYS = 3;
const COMPOST_DAYS = 7;

// --- Frontmatter parsing ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    // Parse arrays
    if (raw.startsWith('[') && raw.endsWith(']')) {
      meta[key] = raw.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    // Parse numbers
    else if (/^\d+(\.\d+)?$/.test(raw)) {
      meta[key] = parseFloat(raw);
    }
    // Parse strings
    else {
      meta[key] = raw.trim();
    }
  }

  const body = content.slice(match[0].length).trim();
  return { meta, body };
}

function serializeFrontmatter(meta, body) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(', ')}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}

// --- File scanning ---

function scanStage(stage) {
  const dir = path.join(GARDEN, stage);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const filePath = path.join(dir, f);
      const content = fs.readFileSync(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      return { file: f, path: filePath, stage, meta, body };
    });
}

function scanAll() {
  const files = [];
  for (const stage of STAGES) {
    files.push(...scanStage(stage));
  }
  return files;
}

// --- Promotion logic ---

function moveFile(entry, toStage, reason) {
  const dest = path.join(GARDEN, toStage, entry.file);
  fs.renameSync(entry.path, dest);
  console.log(`  [${entry.stage} → ${toStage}] ${entry.file} — ${reason}`);
  return { file: entry.file, from: entry.stage, to: toStage, reason };
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr);
  if (isNaN(then.getTime())) return Infinity;
  return (Date.now() - then.getTime()) / (1000 * 60 * 60 * 24);
}

function shouldPromoteToGrowing(entry) {
  const m = entry.meta;
  // Challenged seeds get promoted faster (threshold 0.5 instead of 0.7)
  const confidenceThreshold = (m.survived_challenges || 0) > 0 ? 0.5 : 0.7;
  return (
    entry.stage === 'seeds' &&
    (m.touch_count || 0) >= 2 &&
    m.planted_by !== m.last_touched_by &&
    (m.confidence || 0) > confidenceThreshold
  );
}

function shouldPromoteToMature(entry) {
  const m = entry.meta;
  return (
    entry.stage === 'growing' &&
    (m.survived_challenges || 0) >= 2 &&
    (m.confidence || 0) > 0.9
  );
}

function shouldCompost(entry) {
  if (entry.stage === 'compost') return false;
  if (entry.stage === 'mature') return false; // don't auto-compost mature ideas
  return daysSince(entry.meta.last_touched_at) > STALE_DAYS;
}

// --- Status generation ---

function generateStatus(files, movements) {
  const now = new Date().toISOString();
  const byStage = {};
  for (const stage of STAGES) {
    byStage[stage] = files.filter(f => f.stage === stage);
  }

  // Account for movements (files have moved since scan)
  for (const m of movements) {
    byStage[m.from] = byStage[m.from].filter(f => f.file !== m.file);
    const moved = files.find(f => f.file === m.file);
    if (moved) {
      moved.stage = m.to;
      byStage[m.to].push(moved);
    }
  }

  const mostActive = [...files]
    .sort((a, b) => (b.meta.touch_count || 0) - (a.meta.touch_count || 0))
    .slice(0, 5);

  const recentlyComposted = movements
    .filter(m => m.to === 'compost')
    .map(m => m.file);

  const lines = [
    '# Garden Status',
    '',
    `*Last tended: ${now}*`,
    '',
    '## Overview',
    '',
    `| Stage | Count |`,
    `|-------|-------|`,
    `| Seeds | ${byStage.seeds.length} |`,
    `| Growing | ${byStage.growing.length} |`,
    `| Mature | ${byStage.mature.length} |`,
    `| Compost | ${byStage.compost.length} |`,
    `| **Total** | **${files.length}** |`,
    '',
  ];

  if (mostActive.length > 0) {
    lines.push('## Most Active Ideas', '');
    for (const f of mostActive) {
      const conf = f.meta.confidence !== undefined ? f.meta.confidence : '?';
      lines.push(`- **${f.file}** (${f.stage}) — touches: ${f.meta.touch_count || 0}, confidence: ${conf}`);
    }
    lines.push('');
  }

  if (movements.length > 0) {
    lines.push('## Recent Movements', '');
    for (const m of movements) {
      lines.push(`- \`${m.file}\`: ${m.from} → ${m.to} — ${m.reason}`);
    }
    lines.push('');
  }

  if (recentlyComposted.length > 0) {
    lines.push('## Recently Composted', '');
    for (const f of recentlyComposted) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  // Ideas by tag
  const tagMap = {};
  for (const f of files) {
    const tags = f.meta.tags || [];
    for (const t of tags) {
      if (!tagMap[t]) tagMap[t] = [];
      tagMap[t].push(f.file);
    }
  }
  if (Object.keys(tagMap).length > 0) {
    lines.push('## Tags', '');
    for (const [tag, tagFiles] of Object.entries(tagMap).sort()) {
      lines.push(`- **${tag}**: ${tagFiles.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---', '*Generated by garden-tender.js*');
  return lines.join('\n');
}

// --- Main ---

function tend() {
  console.log('🌱 Tending the Knowledge Garden...\n');

  const files = scanAll();
  console.log(`Found ${files.length} files across ${STAGES.length} stages.\n`);

  const movements = [];

  // Check promotions, stale warnings, active composting
  for (const entry of files) {
    if (shouldPromoteToMature(entry)) {
      movements.push(moveFile(entry, 'mature', 'survived_challenges >= 2, confidence > 0.9'));
    } else if (shouldPromoteToGrowing(entry)) {
      const thresh = (entry.meta.survived_challenges || 0) > 0 ? 0.5 : 0.7;
      movements.push(moveFile(entry, 'growing', `both agents touched, confidence > ${thresh}`));
    } else if (entry.stage === 'seeds') {
      const age = daysSince(entry.meta.planted_at || entry.meta.last_touched_at);
      const hasSecondAgent = entry.meta.planted_by !== entry.meta.last_touched_by && (entry.meta.touch_count || 0) >= 2;
      
      if (age > COMPOST_DAYS && !hasSecondAgent) {
        // Active compost: 7+ days without second agent
        const content = fs.readFileSync(entry.path, 'utf8');
        fs.writeFileSync(entry.path, content + '\n<!-- COMPOSTED: No cross-agent engagement after 7 days -->\n');
        movements.push(moveFile(entry, 'compost', 'no cross-agent engagement after 7 days'));
      } else if (age > STALE_WARNING_DAYS && !hasSecondAgent) {
        // Stale warning: 3+ days without second agent
        const content = fs.readFileSync(entry.path, 'utf8');
        if (!content.includes('<!-- STALE:')) {
          fs.writeFileSync(entry.path, content + '\n<!-- STALE: This seed needs attention or will be composted in 4 days -->\n');
          console.log(`  [warning] ${entry.file} — stale, needs second agent attention`);
        }
      }
    } else if (shouldCompost(entry)) {
      movements.push(moveFile(entry, 'compost', `untouched for ${STALE_DAYS}+ days`));
    }
  }

  if (movements.length === 0) {
    console.log('  No movements needed.\n');
  } else {
    console.log(`\n  ${movements.length} file(s) moved.\n`);
  }

  // Generate status
  const status = generateStatus(files, movements);
  const statusPath = path.join(GARDEN, 'STATUS.md');
  fs.writeFileSync(statusPath, status);
  console.log(`Status written to ${statusPath}`);

  // Generate search index
  const index = { seeds: [], growing: [], mature: [] };
  for (const entry of files) {
    if (!['seeds', 'growing', 'mature'].includes(entry.stage)) continue;
    // Account for movements
    let stage = entry.stage;
    const moved = movements.find(m => m.file === entry.file);
    if (moved) stage = moved.to;
    if (!['seeds', 'growing', 'mature'].includes(stage)) continue;

    const firstLine = entry.body.split('\n').find(l => l.trim().length > 0) || '';
    const ageDays = Math.round(daysSince(entry.meta.planted_at || entry.meta.last_touched_at) * 10) / 10;

    index[stage].push({
      file: entry.file,
      tags: entry.meta.tags || [],
      planted_by: entry.meta.planted_by || 'unknown',
      confidence: entry.meta.confidence || 0,
      age_days: isFinite(ageDays) ? ageDays : 0,
      summary: firstLine.slice(0, 200)
    });
  }

  const indexPath = path.join(GARDEN, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`Index written to ${indexPath}`);
}

tend();
