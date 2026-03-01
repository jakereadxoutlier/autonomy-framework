#!/usr/bin/env node
/**
 * Aha Moment Detection — finds cross-pollination between ticks/seeds.
 * Run: node detect-aha.js
 */

const fs = require('fs');
const path = require('path');

const AGENT_HOME_DIR = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const JOURNAL = path.join(CLAWD, 'evolution', 'tick-journal.md');
const INDEX = path.join(CLAWD, 'evolution', 'garden', 'index.json');
const OUTPUT = path.join(CLAWD, 'evolution', 'signals', 'aha-moments.jsonl');

function parseTicks(content) {
  const blocks = content.split(/\n(?=## Tick \d+)/).filter(b => /^## Tick \d+/.test(b));
  return blocks.map(block => {
    const m = block.match(/^## Tick (\d+)\s*-\s*[^-]+-\s*(.*)/);
    if (!m) return null;
    const num = parseInt(m[1]);
    const frontier = m[2].trim().toLowerCase();
    const keyIdeas = [];
    for (const im of block.matchAll(/\*\*KEY IDEA\b[^:]*:?\*?\*?\s*(.*)/gi)) {
      keyIdeas.push(im[1].trim());
    }
    return { num, frontier, keyIdeas };
  }).filter(Boolean);
}

function extractConcepts(text) {
  // Extract meaningful multi-word concepts and significant words
  const concepts = [];
  const phrases = text.match(/[a-z]+-[a-z]+/g) || []; // hyphenated terms
  concepts.push(...phrases);
  const words = text.toLowerCase().match(/\b[a-z]{6,}\b/g) || [];
  const stopwords = new Set(['should','through','before','after','between','another','because','however','without','within','already','something']);
  concepts.push(...words.filter(w => !stopwords.has(w)));
  return [...new Set(concepts)];
}

function main() {
  const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8') : '';
  const ticks = parseTicks(journal);
  let seeds = [];
  if (fs.existsSync(INDEX)) {
    try { seeds = JSON.parse(fs.readFileSync(INDEX, 'utf8')).seeds || []; } catch {}
  }

  const ahas = [];

  // 1. Cross-frontier ideas: tick's KEY IDEA mentions concepts from a DIFFERENT frontier
  for (const tick of ticks) {
    const frontierConcepts = extractConcepts(tick.frontier);
    for (const idea of tick.keyIdeas) {
      const ideaConcepts = extractConcepts(idea.toLowerCase());
      for (const other of ticks) {
        if (other.num === tick.num) continue;
        const otherConcepts = extractConcepts(other.frontier);
        const overlap = ideaConcepts.filter(c => otherConcepts.includes(c) && !frontierConcepts.includes(c));
        if (overlap.length > 0) {
          ahas.push({
            ts: new Date().toISOString(),
            type: 'cross-pollination',
            idea_a: tick.frontier,
            idea_b: other.frontier,
            connection: `Tick ${tick.num}'s idea "${idea.slice(0, 80)}" references concepts from ${other.frontier}: ${overlap.join(', ')}`,
            source_ticks: [tick.num, other.num]
          });
        }
      }
    }
  }

  // 2. Seeds sharing tags across different planted_by agents
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const a = seeds[i], b = seeds[j];
      if (!a.tags || !b.tags || a.planted_by === b.planted_by) continue;
      const shared = (a.tags || []).filter(t => (b.tags || []).includes(t));
      if (shared.length > 0) {
        ahas.push({
          ts: new Date().toISOString(),
          type: 'cross-agent-tags',
          idea_a: a.id || a.file,
          idea_b: b.id || b.file,
          connection: `Shared tags [${shared.join(', ')}] across agents ${a.planted_by} and ${b.planted_by}`,
          source_seeds: [a.id, b.id]
        });
      }
    }
  }

  if (ahas.length === 0) {
    console.log('[aha] No aha moments detected this run.');
    return;
  }

  // Deduplicate against existing
  let existing = '';
  if (fs.existsSync(OUTPUT)) existing = fs.readFileSync(OUTPUT, 'utf8');

  let added = 0;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  for (const aha of ahas) {
    const key = `${aha.idea_a}|${aha.idea_b}`;
    if (!existing.includes(key)) {
      fs.appendFileSync(OUTPUT, JSON.stringify(aha) + '\n');
      added++;
      console.log(`[aha] Found: ${aha.type} — ${aha.idea_a} × ${aha.idea_b}`);
    }
  }
  console.log(`[aha] ${added} new aha moments written to ${OUTPUT}`);
}

main();
