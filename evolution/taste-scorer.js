#!/usr/bin/env node
/**
 * Taste Scorer — scores garden seeds on novelty, specificity, connectivity, ambition.
 * Writes taste_score and flag to garden/index.json.
 * Run: node taste-scorer.js
 */

const fs = require('fs');
const path = require('path');

const CLAWD = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const GARDEN_DIR = path.join(CLAWD, 'evolution', 'garden');
const INDEX_PATH = path.join(GARDEN_DIR, 'index.json');
const JOURNAL_PATH = path.join(CLAWD, 'evolution', 'tick-journal.md');

function loadIndex() {
  if (fs.existsSync(INDEX_PATH)) {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  }
  return { seeds: [] };
}

function loadJournal() {
  if (fs.existsSync(JOURNAL_PATH)) {
    return fs.readFileSync(JOURNAL_PATH, 'utf8');
  }
  return '';
}

function loadSeedFiles() {
  // Also scan for individual seed .md files in garden/
  const seeds = [];
  if (!fs.existsSync(GARDEN_DIR)) return seeds;
  for (const f of fs.readdirSync(GARDEN_DIR)) {
    if (f.endsWith('.md')) {
      seeds.push({
        file: f,
        content: fs.readFileSync(path.join(GARDEN_DIR, f), 'utf8')
      });
    }
  }
  return seeds;
}

// Specificity: count actionable items (bullets starting with - or * that contain verbs/actions)
function scoreSpecificity(text) {
  const lines = text.split('\n');
  const bullets = lines.filter(l => /^\s*[-*]\s/.test(l));
  const actionable = bullets.filter(l =>
    /\b(create|build|implement|write|add|remove|deploy|test|check|run|install|configure|send|parse|generate|score|detect|read|scan|update)\b/i.test(l)
  );
  if (bullets.length === 0) return 0.2; // vague
  return Math.min(1, actionable.length / Math.max(bullets.length, 3));
}

// Connectivity: how many times this seed's key concepts appear in tick-journal
function scoreConnectivity(text, journal) {
  // Extract key nouns/concepts (words > 5 chars, not common)
  const words = text.toLowerCase().match(/\b[a-z]{6,}\b/g) || [];
  const unique = [...new Set(words)].slice(0, 10);
  if (unique.length === 0) return 0;
  let hits = 0;
  for (const w of unique) {
    const re = new RegExp(w, 'gi');
    const matches = journal.match(re);
    if (matches) hits += Math.min(matches.length, 3); // cap per word
  }
  return Math.min(1, hits / (unique.length * 2));
}

// Ambition: does it reference novel/frontier concepts?
function scoreAmbition(text) {
  const ambitiousTerms = [
    'novel', 'frontier', 'unsolved', 'breakthrough', 'nobody', 'first',
    'revolutionary', 'paradigm', 'emergent', 'self-modify', 'autonomous',
    'compose', 'synthesize', 'invent', 'discover', 'consciousness',
    'meta-', 'recursive', 'cross-pollination', 'unifying'
  ];
  const lower = text.toLowerCase();
  let hits = 0;
  for (const t of ambitiousTerms) {
    if (lower.includes(t)) hits++;
  }
  // Also check length — ambitious ideas tend to be more developed
  const lengthBonus = Math.min(0.3, text.length / 3000);
  return Math.min(1, (hits / 4) + lengthBonus);
}

// Novelty: simple heuristic (web_search not available in Node, use text analysis)
function scoreNovelty(text) {
  // Check for unique combinations, questions, "what if" statements
  const noveltyMarkers = [
    /what if/i, /nobody.*done/i, /unsolved/i, /new approach/i,
    /combine.*with/i, /cross.*pollinat/i, /unexplored/i,
    /\?/, /could we/i, /imagine/i, /hasn't been/i
  ];
  let hits = 0;
  for (const r of noveltyMarkers) {
    if (r.test(text)) hits++;
  }
  return Math.min(1, hits / 3);
}

function main() {
  const index = loadIndex();
  const journal = loadJournal();
  const seedFiles = loadSeedFiles();

  // Build seed list from index + files
  let seeds = index.seeds || [];

  // Also add seeds from .md files not in index
  for (const sf of seedFiles) {
    const existing = seeds.find(s => s.file === sf.file || s.id === sf.file.replace('.md', ''));
    if (!existing) {
      seeds.push({ id: sf.file.replace('.md', ''), file: sf.file, content: sf.content });
    } else if (!existing.content) {
      existing.content = sf.content;
    }
  }

  if (seeds.length === 0) {
    console.log('[taste-scorer] No seeds found in garden. Nothing to score.');
    return;
  }

  console.log(`[taste-scorer] Scoring ${seeds.length} seeds...`);

  for (const seed of seeds) {
    const text = seed.content || seed.description || seed.idea || seed.id || '';
    const novelty = scoreNovelty(text);
    const specificity = scoreSpecificity(text);
    const connectivity = scoreConnectivity(text, journal);
    const ambition = scoreAmbition(text);

    const taste_score = +(( novelty * 0.25 + specificity * 0.25 + connectivity * 0.25 + ambition * 0.25 ).toFixed(3));

    seed.taste_score = taste_score;
    seed.taste_dimensions = { novelty: +novelty.toFixed(3), specificity: +specificity.toFixed(3), connectivity: +connectivity.toFixed(3), ambition: +ambition.toFixed(3) };

    if (taste_score > 0.7) {
      seed.taste_flag = 'HIGH POTENTIAL';
    } else if (taste_score < 0.3) {
      seed.taste_flag = 'RECONSIDER';
    } else {
      delete seed.taste_flag;
    }

    console.log(`  ${seed.id || seed.file}: ${taste_score} ${seed.taste_flag || ''}`);
  }

  index.seeds = seeds;
  index.taste_scored_at = new Date().toISOString();
  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
  console.log(`[taste-scorer] Wrote scores to ${INDEX_PATH}`);
}

main();
