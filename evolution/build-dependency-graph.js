#!/usr/bin/env node
/**
 * Build Dependency Graph — parses tick-journal.md CONNECTION fields.
 * Writes to signals/dependency-graph.json.
 * Run: node build-dependency-graph.js
 */

const fs = require('fs');
const path = require('path');

const CLAWD = process.env.AGENT_HOME || path.join(process.env.HOME, 'autonomy');
const JOURNAL = path.join(CLAWD, 'evolution', 'tick-journal.md');
const OUTPUT = path.join(CLAWD, 'evolution', 'signals', 'dependency-graph.json');

function main() {
  if (!fs.existsSync(JOURNAL)) {
    console.log('[dep-graph] No tick-journal.md found.');
    return;
  }

  const content = fs.readFileSync(JOURNAL, 'utf8');

  // Parse ticks
  const tickBlocks = content.split(/\n(?=## Tick \d+)/).filter(b => /^## Tick \d+/.test(b));
  const ticks = [];

  for (const block of tickBlocks) {
    const headerMatch = block.match(/^## Tick (\d+)\s*-\s*([^-]+)-\s*(.*)/);
    if (!headerMatch) continue;
    const num = parseInt(headerMatch[1]);
    const frontier = headerMatch[3].trim();

    // Extract CONNECTION lines
    const connections = [];
    const connMatches = block.matchAll(/\*\*CONNECTION\*?\*?:?\s*(.*)/gi);
    for (const m of connMatches) {
      connections.push(m[1].trim());
    }

    // Extract KEY IDEAs
    const keyIdeas = [];
    const ideaMatches = block.matchAll(/\*\*KEY IDEA\b[^:]*:?\*?\*?\s*(.*)/gi);
    for (const m of ideaMatches) {
      keyIdeas.push(m[1].trim());
    }

    ticks.push({ num, frontier, connections, keyIdeas, raw: block });
  }

  // Build edges from CONNECTION fields
  const edges = [];
  for (const tick of ticks) {
    for (const conn of tick.connections) {
      // Look for references to other ticks: "Tick N" or "tick N"
      const refs = conn.matchAll(/[Tt]ick\s+(\d+)/g);
      for (const ref of refs) {
        const targetTick = parseInt(ref[1]);
        if (targetTick !== tick.num) {
          edges.push({
            from_tick: Math.min(targetTick, tick.num),
            to_tick: Math.max(targetTick, tick.num),
            relation: 'builds-on',
            detail: conn
          });
        }
      }

      // Also detect concept references to other ticks' frontiers
      for (const other of ticks) {
        if (other.num === tick.num) continue;
        const frontier_words = other.frontier.toLowerCase().split(/\s+/).filter(w => w.length > 4);
        for (const w of frontier_words) {
          if (conn.toLowerCase().includes(w)) {
            const from = Math.min(other.num, tick.num);
            const to = Math.max(other.num, tick.num);
            if (!edges.find(e => e.from_tick === from && e.to_tick === to)) {
              edges.push({
                from_tick: from,
                to_tick: to,
                relation: 'concept-link',
                detail: `"${w}" connects ${other.frontier} and ${tick.frontier}`
              });
            }
            break;
          }
        }
      }
    }
  }

  // Detect orphans
  const connected = new Set();
  for (const e of edges) {
    connected.add(e.from_tick);
    connected.add(e.to_tick);
  }
  const orphans = ticks.filter(t => !connected.has(t.num)).map(t => t.num);

  const graph = {
    edges,
    orphan_ticks: orphans,
    tick_count: ticks.length,
    generated_at: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(graph, null, 2) + '\n');
  console.log(`[dep-graph] Built graph: ${edges.length} edges, ${orphans.length} orphans, ${ticks.length} ticks`);
  if (orphans.length > 0) {
    console.log(`[dep-graph] Orphan ticks (possible dead ends): ${orphans.join(', ')}`);
  }
}

main();
