#!/usr/bin/env node
// Build a knowledge graph from tick journal, garden, and aha moments
// Run: node build-knowledge-graph.js
// Query: node build-knowledge-graph.js --related "curiosity"

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const GRAPH_FILE = path.join(BASE, 'knowledge-graph.json');
const JOURNAL = path.join(BASE, 'tick-journal.md');
const GARDEN_INDEX = path.join(BASE, '..', 'garden', 'index.json');
const AHA_FILE = path.join(BASE, 'signals', 'aha-moments.jsonl');

function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf-8').split('\n').filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function safeJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
}

function extractFromJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  const content = fs.readFileSync(JOURNAL, 'utf-8');
  const nodes = [];
  const tickRegex = /^## Tick (\d+) - .* - (.+)$/gm;
  let match;
  while ((match = tickRegex.exec(content)) !== null) {
    const tickNum = match[1];
    const frontier = match[2].trim();
    const id = frontier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    // Extract tags from the section content (next lines until next ##)
    const sectionStart = match.index + match[0].length;
    const nextTick = content.indexOf('\n## ', sectionStart);
    const section = content.slice(sectionStart, nextTick === -1 ? undefined : nextTick);
    const tags = [];
    // Look for keywords
    const keywords = ['skill', 'cron', 'bridge', 'nerve', 'garden', 'compression', 'attention',
      'neuroscience', 'architecture', 'emergence', 'meta', 'experiment', 'curiosity', 'evolution'];
    for (const kw of keywords) {
      if (section.toLowerCase().includes(kw)) tags.push(kw);
    }
    nodes.push({ id, type: 'concept', source: `tick-${tickNum}`, tags, label: frontier });
  }
  return nodes;
}

function extractFromGarden() {
  const index = safeJson(GARDEN_INDEX, { seeds: [] });
  return (index.seeds || []).map(s => ({
    id: (s.file || '').replace('.md', '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    type: 'seed',
    source: 'garden',
    tags: s.tags || [],
    label: s.summary || s.file
  }));
}

function extractFromAha() {
  return readJsonl(AHA_FILE).map((a, i) => ({
    id: `aha-${i}`,
    type: 'insight',
    source: 'aha-moments',
    tags: a.tags || [],
    label: a.insight || a.description || JSON.stringify(a).slice(0, 80)
  }));
}

function buildEdges(nodes) {
  const edges = [];
  // Connect nodes that share tags
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].tags.filter(t => nodes[j].tags.includes(t));
      if (shared.length > 0) {
        edges.push({
          from: nodes[i].id,
          to: nodes[j].id,
          relation: 'shares-tags',
          sharedTags: shared,
          weight: Math.min(1, shared.length * 0.3)
        });
      }
    }
  }
  return edges;
}

function queryRelated(graph, term) {
  const t = term.toLowerCase();
  const matching = graph.nodes.filter(n =>
    n.id.includes(t) || (n.label || '').toLowerCase().includes(t) ||
    n.tags.some(tag => tag.includes(t))
  );
  const matchIds = new Set(matching.map(n => n.id));
  const connected = graph.edges.filter(e => matchIds.has(e.from) || matchIds.has(e.to));
  const relatedIds = new Set();
  connected.forEach(e => { relatedIds.add(e.from); relatedIds.add(e.to); });
  const related = graph.nodes.filter(n => relatedIds.has(n.id) && !matchIds.has(n.id));

  console.log(`\nNodes matching "${term}":`);
  matching.forEach(n => console.log(`  [${n.type}] ${n.id} — ${n.label || ''} (tags: ${n.tags.join(', ')})`));
  console.log(`\nConnected nodes:`);
  related.forEach(n => console.log(`  [${n.type}] ${n.id} — ${n.label || ''}`));
  console.log(`\nEdges: ${connected.length}`);
}

function main() {
  const args = process.argv.slice(2);
  const relatedIdx = args.indexOf('--related');

  if (relatedIdx !== -1 && args[relatedIdx + 1]) {
    const graph = safeJson(GRAPH_FILE, { nodes: [], edges: [] });
    queryRelated(graph, args[relatedIdx + 1]);
    return;
  }

  // Build
  const journalNodes = extractFromJournal();
  const gardenNodes = extractFromGarden();
  const ahaNodes = extractFromAha();
  const allNodes = [...journalNodes, ...gardenNodes, ...ahaNodes];

  // Deduplicate by id
  const seen = new Set();
  const nodes = allNodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });
  const edges = buildEdges(nodes);

  const graph = { nodes, edges, built: new Date().toISOString() };
  fs.writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2));
  console.log(`Knowledge graph: ${nodes.length} nodes, ${edges.length} edges → knowledge-graph.json`);
}

main();
