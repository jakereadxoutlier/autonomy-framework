#!/usr/bin/env node
// Consolidation cycles — the evolution engine's REM sleep
// Synthesizes all tick journal + knowledge graph into a coherent narrative
// Run: node consolidate.js
// Suggested cron: every 6 hours (0 */6 * * *)

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const JOURNAL = path.join(BASE, 'tick-journal.md');
const GRAPH_FILE = path.join(BASE, 'knowledge-graph.json');
const SYNTHESIS = path.join(BASE, 'SYNTHESIS.md');

function safeRead(f) { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } }
function safeJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fb; } }

function extractTicks(journal) {
  const ticks = [];
  const regex = /^## Tick (\d+) - ([^\n]+)\n([\s\S]*?)(?=\n## Tick|\n*$)/gm;
  let m;
  while ((m = regex.exec(journal)) !== null) {
    ticks.push({ num: parseInt(m[1]), header: m[2].trim(), body: m[3].trim() });
  }
  return ticks;
}

function findThemes(ticks) {
  const wordFreq = {};
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have',
    'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and', 'but',
    'or', 'not', 'no', 'this', 'that', 'it', 'its', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
    'what', 'which', 'who', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
    'some', 'such', 'than', 'too', 'very', 'just', 'about', 'also', 'so', 'if', 'when', 'then']);
  for (const t of ticks) {
    const words = (t.header + ' ' + t.body).toLowerCase().match(/[a-z]{4,}/g) || [];
    for (const w of words) {
      if (!stopwords.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
    }
  }
  return Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count }));
}

function findClusters(graph) {
  // Find highly connected nodes
  const degree = {};
  for (const e of graph.edges || []) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  const nodeMap = {};
  for (const n of graph.nodes || []) nodeMap[n.id] = n;

  return Object.entries(degree)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, deg]) => ({ id, connections: deg, node: nodeMap[id] || { label: id } }));
}

function findUnexplored(graph) {
  // Nodes with 0 or 1 connections
  const degree = {};
  for (const n of graph.nodes || []) degree[n.id] = 0;
  for (const e of graph.edges || []) {
    degree[e.from] = (degree[e.from] || 0) + 1;
    degree[e.to] = (degree[e.to] || 0) + 1;
  }
  return (graph.nodes || []).filter(n => (degree[n.id] || 0) <= 1);
}

function main() {
  const journal = safeRead(JOURNAL);
  const graph = safeJson(GRAPH_FILE, { nodes: [], edges: [] });
  const ticks = extractTicks(journal);
  const themes = findThemes(ticks);
  const clusters = findClusters(graph);
  const unexplored = findUnexplored(graph);

  const now = new Date().toISOString();
  let doc = `# Evolution Synthesis\n\n*Consolidated: ${now}*\n*Ticks analyzed: ${ticks.length} | Nodes: ${(graph.nodes||[]).length} | Edges: ${(graph.edges||[]).length}*\n\n---\n\n`;

  doc += `## What We've Learned So Far\n\n`;
  if (ticks.length === 0) {
    doc += `No ticks recorded yet. The system is freshly initialized.\n\n`;
  } else {
    doc += `Across ${ticks.length} evolution ticks, the system has explored:\n\n`;
    for (const t of ticks) {
      doc += `- **Tick ${t.num}** — ${t.header}\n`;
    }
    doc += `\n`;
  }

  doc += `## Strongest Ideas and Why\n\n`;
  doc += `Top themes by frequency across all ticks:\n\n`;
  for (const t of themes.slice(0, 10)) {
    doc += `- **${t.word}** (${t.count} mentions)\n`;
  }
  doc += `\n`;

  if (clusters.length > 0) {
    doc += `Most connected concepts in the knowledge graph:\n\n`;
    for (const c of clusters.slice(0, 5)) {
      doc += `- **${c.id}** — ${c.connections} connections (${c.node.label || ''})\n`;
    }
    doc += `\n`;
  }

  doc += `## Unexplored Connections Worth Investigating\n\n`;
  if (unexplored.length === 0) {
    doc += `All nodes are well-connected. Consider adding new frontier concepts.\n\n`;
  } else {
    doc += `These nodes have few or no connections — potential unexplored territory:\n\n`;
    for (const n of unexplored.slice(0, 10)) {
      doc += `- **${n.id}** [${n.type}] — ${n.label || ''} (tags: ${(n.tags||[]).join(', ')})\n`;
    }
    doc += `\n`;
  }

  doc += `## Dead Ends to Avoid\n\n`;
  doc += `*No dead ends identified yet. As experiments fail, they'll be logged here.*\n\n`;

  // Check for failed experiments
  const expFile = path.join(BASE, 'signals', 'experiments.jsonl');
  if (fs.existsSync(expFile)) {
    const lines = fs.readFileSync(expFile, 'utf-8').split('\n').filter(l => l.trim());
    const failed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && (e.result === 'failed' || e.outcome === 'failed'));
    if (failed.length > 0) {
      doc += `Known failed experiments:\n\n`;
      for (const f of failed) {
        doc += `- ${f.name || f.experiment || 'unnamed'}: ${f.reason || f.error || 'unknown reason'}\n`;
      }
      doc += `\n`;
    }
  }

  doc += `---\n*Next consolidation should run in ~6 hours*\n`;

  fs.writeFileSync(SYNTHESIS, doc);
  console.log(`Synthesis complete → SYNTHESIS.md (${ticks.length} ticks, ${themes.length} themes, ${clusters.length} clusters)`);
}

main();
