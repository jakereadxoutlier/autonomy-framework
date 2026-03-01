#!/usr/bin/env node
// Export evolution system as a clean, shareable document
// Sanitized: strips API keys, personal info, project-specific details
// Run: node export.js

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname);
const GARDEN = path.join(BASE, '..', 'garden');
const SYNTHESIS = path.join(BASE, 'SYNTHESIS.md');
const GRAPH_FILE = path.join(BASE, 'knowledge-graph.json');
const EXPORT_FILE = path.join(BASE, 'EXPORT.md');

function safeRead(f) { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } }
function safeJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fb; } }

function sanitize(text) {
  return text
    // API keys, tokens, secrets
    .replace(/[A-Za-z0-9_-]{20,}(?=.*(?:key|token|secret|password|api))/gi, '[REDACTED]')
    .replace(/(sk-|ghp_|sbp_|eyJ|sntr)[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/\b[A-Z0-9]{20,}\b/g, '[REDACTED]')
    // Emails
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
    // IPs
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]')
    // Phone numbers
    .replace(/\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]')
    // Paths with usernames
    .replace(/\/Users\/\w+\//g, '~/')
    // Specific names (generic)
    .replace(/\bJake\b/gi, '[user]');
}

function getMatureSeeds() {
  const matureDir = path.join(GARDEN, 'mature');
  if (!fs.existsSync(matureDir)) return [];
  return fs.readdirSync(matureDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = safeRead(path.join(matureDir, f));
      const title = (content.match(/^#\s+(.+)/m) || [, f])[1];
      const summary = content.split('\n').filter(l => l.trim() && !l.startsWith('#')).slice(0, 3).join(' ');
      return { file: f, title, summary: sanitize(summary).slice(0, 200) };
    });
}

function main() {
  const synthesis = safeRead(SYNTHESIS);
  const graph = safeJson(GRAPH_FILE, { nodes: [], edges: [] });
  const seeds = getMatureSeeds();
  const now = new Date().toISOString();

  let doc = `# Evolution System — Export\n\n*Generated: ${now}*\n\n---\n\n`;

  doc += `## What Is This?\n\n`;
  doc += `An autonomous self-improvement system for AI agents. It combines:\n\n`;
  doc += `- **Evolution Engine** — Timed "ticks" that explore research frontiers, build capabilities, and track progress in a journal\n`;
  doc += `- **Knowledge Garden** — Ideas start as seeds, grow through stages (seed → growing → mature → compost), with a garden tender that prunes and promotes\n`;
  doc += `- **Nervous System** — Event-driven daemon replacing cron jobs; reacts to file changes, signals, and cascading triggers\n`;
  doc += `- **Bridge Protocol** — File-based IPC between a conversational AI (OpenClaw) and a coding AI (Claude Code CLI), enabling autonomous code generation\n`;
  doc += `- **Knowledge Graph** — Extracted concepts, capabilities, and insights connected by shared themes\n`;
  doc += `- **Consolidation** — Periodic synthesis (like REM sleep) that integrates learnings into a coherent narrative\n`;
  doc += `- **Adversarial Testing** — Self-generated edge cases to find and fix fragility\n`;
  doc += `- **Pattern Extraction** — Automatic identification of reusable code patterns across the codebase\n\n`;

  doc += `## Key Discoveries\n\n`;
  if (synthesis) {
    // Extract the "What We've Learned" section
    const learned = synthesis.match(/## What We've Learned So Far\n\n([\s\S]*?)(?=\n## )/);
    if (learned) doc += sanitize(learned[1]) + '\n';
  }

  doc += `### Knowledge Graph Stats\n\n`;
  doc += `- **${graph.nodes.length}** concepts tracked\n`;
  doc += `- **${graph.edges.length}** connections identified\n`;
  const types = {};
  for (const n of graph.nodes) types[n.type] = (types[n.type] || 0) + 1;
  for (const [t, c] of Object.entries(types)) doc += `- ${c} ${t} nodes\n`;
  doc += `\n`;

  doc += `## Novel Techniques\n\n`;
  doc += `1. **File-based AI-to-AI Bridge** — Two AI systems communicate via markdown files with status fields. No API, no sockets — just a watched directory. Simple, debuggable, resilient.\n\n`;
  doc += `2. **Knowledge Garden Metaphor** — Ideas aren't stored in databases. They're "planted" as markdown files and progress through growth stages based on confidence scores and cross-references.\n\n`;
  doc += `3. **Nervous System Architecture** — Events propagate through a Unix socket bus with cascade rules. A file change can trigger validation → testing → deployment without any cron polling.\n\n`;
  doc += `4. **Self-Adversarial Testing** — The system generates its own edge cases and tests itself, logging crashes for the next evolution cycle to fix.\n\n`;
  doc += `5. **Compression-Based Progress Tracking** — Measuring evolution by how much the system's knowledge compresses (fewer files, more connections, higher abstraction).\n\n`;

  if (seeds.length > 0) {
    doc += `## Mature Ideas\n\n`;
    for (const s of seeds) {
      doc += `### ${s.title}\n${s.summary}\n\n`;
    }
  }

  doc += `## How to Replicate\n\n`;
  doc += `### Requirements\n`;
  doc += `- Node.js 18+\n`;
  doc += `- An AI assistant with file system access (OpenClaw, Claude Code, or similar)\n`;
  doc += `- A coding AI with CLI access for the bridge (Claude Code CLI recommended)\n\n`;
  doc += `### Structure\n`;
  doc += `\`\`\`\n`;
  doc += `evolution/          # Core engine: ticks, bridge, signals\n`;
  doc += `  signals/          # JSONL event logs (failures, experiments, aha moments)\n`;
  doc += `  requests/         # Bridge: outgoing requests to coding AI\n`;
  doc += `  responses/        # Bridge: incoming responses from coding AI\n`;
  doc += `  patterns/         # Extracted reusable code patterns\n`;
  doc += `garden/             # Knowledge garden: seeds → growing → mature → compost\n`;
  doc += `nerve/              # Event-driven nervous system daemon\n`;
  doc += `\`\`\`\n\n`;
  doc += `### Getting Started\n`;
  doc += `1. Set up the bridge daemon: \`node evolution/bridge-daemon.js\`\n`;
  doc += `2. Run your first tick: create a tick entry in \`evolution/tick-journal.md\`\n`;
  doc += `3. Build the knowledge graph: \`node evolution/build-knowledge-graph.js\`\n`;
  doc += `4. Run consolidation: \`node evolution/consolidate.js\`\n`;
  doc += `5. Export: \`node evolution/export.js\`\n\n`;

  doc += `---\n\n*This document was auto-generated by the evolution system's export mechanism.*\n`;

  fs.writeFileSync(EXPORT_FILE, sanitize(doc));
  console.log(`Export complete → EXPORT.md (${doc.length} chars, sanitized)`);
}

main();
