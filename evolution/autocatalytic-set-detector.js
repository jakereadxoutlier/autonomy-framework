#!/usr/bin/env node
// autocatalytic-set-detector.js — Detects autocatalytic sets in the workspace
// Inspired by OEE (Open-Ended Evolution) + artificial chemistry research
// An autocatalytic set: a group of files where each is referenced by at least one other in the group

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const OUTPUT = path.join(__dirname, 'signals', 'autocatalytic-sets.json');
const IGNORE_DIRS = new Set(['node_modules', '.git', 'evolution/snapshots', '.claude']);
const IGNORE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.zip', '.tar', '.gz']);

function shouldIgnore(relPath) {
  // Check each path segment for ignored directory names (catches nested node_modules etc.)
  const segments = relPath.split(path.sep);
  for (const seg of segments) {
    if (seg === 'node_modules' || seg === '.git' || seg === '.claude' || seg === '.next') return true;
  }
  if (relPath.startsWith('evolution/snapshots/')) return true;
  if (IGNORE_EXTS.has(path.extname(relPath).toLowerCase())) return true;
  return false;
}

function walkDir(dir, base = dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (shouldIgnore(rel)) continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results;
}

function extractRefs(content, filePath, allFilesSet) {
  const refs = new Set();
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);

  if (['.js', '.ts', '.mjs', '.cjs', '.tsx', '.jsx'].includes(ext)) {
    let m;
    const reqRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = reqRe.exec(content))) refs.add(resolveRef(m[1], dir));
    const impRe = /import\s+.*?from\s+['"]([^'"]+)['"]/gs;
    while ((m = impRe.exec(content))) refs.add(resolveRef(m[1], dir));
    const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynRe.exec(content))) refs.add(resolveRef(m[1], dir));
  }
  if (['.md', '.markdown'].includes(ext)) {
    let m;
    const wikiRe = /\[\[([^\]]+)\]\]/g;
    while ((m = wikiRe.exec(content))) refs.add(resolveRef(m[1], dir));
    const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
    while ((m = mdLinkRe.exec(content))) {
      if (!m[2].startsWith('http') && !m[2].startsWith('#')) refs.add(resolveRef(m[2], dir));
    }
    const fileRefRe = /`([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})`/g;
    while ((m = fileRefRe.exec(content))) refs.add(resolveRef(m[1], dir));
  }
  if (['.json', '.jsonl'].includes(ext)) {
    let m;
    const refRe = /"\$ref"\s*:\s*"([^"]+)"/g;
    while ((m = refRe.exec(content))) refs.add(resolveRef(m[1], dir));
    const pathRe = /"([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})"/g;
    while ((m = pathRe.exec(content))) {
      if (m[1].includes('/') && !m[1].startsWith('http')) refs.add(resolveRef(m[1], dir));
    }
  }
  if (['.sh', '.bash', '.zsh'].includes(ext) || filePath.includes('bin/')) {
    let m;
    const srcRe = /(?:source|\.)\s+["']?([^\s"'#]+)/g;
    while ((m = srcRe.exec(content))) refs.add(resolveRef(m[1], dir));
    const shPathRe = /(?:cat|node|python|bash|sh|\.\/)\s+["']?([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})/g;
    while ((m = shPathRe.exec(content))) refs.add(resolveRef(m[1], dir));
  }
  const resolved = new Set();
  for (const ref of refs) {
    if (!ref) continue;
    const candidates = [ref, ref + '.js', ref + '.ts', ref + '.json', ref + '.md', ref + '/index.js', ref + '/index.ts'];
    for (const c of candidates) {
      const norm = path.normalize(c);
      if (allFilesSet.has(norm) && norm !== filePath) {
        resolved.add(norm);
        break;
      }
    }
  }
  return resolved;
}

function resolveRef(ref, fromDir) {
  if (!ref || ref.startsWith('http') || ref.startsWith('#')) return null;
  ref = ref.split('#')[0].split('?')[0];
  if (ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('/')) {
    if (ref.startsWith('/')) return path.normalize(ref.slice(1));
    return path.normalize(path.join(fromDir, ref));
  }
  return path.normalize(ref);
}

function getGitEnergy(files) {
  const energy = new Map();
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  try {
    const logOutput = execSync(
      'git log --format="%H %aI" --name-only --diff-filter=AMRC --since="90 days ago"',
      { cwd: WORKSPACE, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );

    const commitTimes = new Map();
    let currentTime = null;
    for (const line of logOutput.split('\n')) {
      const commitMatch = line.match(/^[0-9a-f]{40}\s+(.+)$/);
      if (commitMatch) {
        currentTime = new Date(commitMatch[1]).getTime();
        continue;
      }
      const file = line.trim();
      if (file && currentTime) {
        if (!commitTimes.has(file)) commitTimes.set(file, []);
        commitTimes.get(file).push(currentTime);
      }
    }

    for (const file of files) {
      const times = commitTimes.get(file) || [];
      if (times.length === 0) {
        energy.set(file, { score: 0, lastModified: null, commits: 0 });
        continue;
      }
      const latest = Math.max(...times);
      const recency = Math.max(0, 1 - (now - latest) / thirtyDays);
      const frequency = Math.min(times.length / 10, 1);
      const score = Math.round((recency * 0.7 + frequency * 0.3) * 100) / 100;
      energy.set(file, { score, lastModified: new Date(latest).toISOString(), commits: times.length });
    }
  } catch {
    for (const f of files) energy.set(f, { score: 0, lastModified: null, commits: 0 });
  }

  return energy;
}

function tarjanSCC(adjacency, nodes) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const neighbors = adjacency.get(v) || new Set();
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

function detectParasites(adjacency, reverseAdj, energy) {
  const parasites = [];
  for (const [file, inbound] of reverseAdj) {
    const outbound = adjacency.get(file) || new Set();
    const e = energy.get(file) || { score: 0, commits: 0 };
    if (inbound.size >= 3 && outbound.size === 0 && e.score < 0.2) {
      parasites.push({
        file,
        inbound_refs: inbound.size,
        outbound_refs: outbound.size,
        energy: e.score,
        reason: 'heavily imported, never modified, contributes no outputs'
      });
    }
  }
  return parasites.sort((a, b) => b.inbound_refs - a.inbound_refs);
}

function main() {
  console.log('Scanning workspace:', WORKSPACE);
  const allFiles = walkDir(WORKSPACE);
  const allFilesSet = new Set(allFiles);
  console.log(`Found ${allFiles.length} files`);

  const adjacency = new Map();
  const reverseAdj = new Map();
  let totalEdges = 0;

  for (const file of allFiles) {
    const fullPath = path.join(WORKSPACE, file);
    let content;
    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
    const refs = extractRefs(content, file, allFilesSet);
    adjacency.set(file, refs);
    totalEdges += refs.size;
    for (const ref of refs) {
      if (!reverseAdj.has(ref)) reverseAdj.set(ref, new Set());
      reverseAdj.get(ref).add(file);
    }
  }
  console.log(`Built graph: ${totalEdges} edges`);

  const sccs = tarjanSCC(adjacency, allFiles);
  const autocatalyticSets = sccs
    .filter(scc => scc.length > 1)
    .map(scc => {
      let internalEdges = 0;
      for (const node of scc) {
        const refs = adjacency.get(node) || new Set();
        for (const ref of refs) {
          if (scc.includes(ref)) internalEdges++;
        }
      }
      const maxEdges = scc.length * (scc.length - 1);
      const strength = maxEdges > 0 ? Math.round((internalEdges / maxEdges) * 100) / 100 : 0;
      return { files: scc.sort(), strength, size: scc.length, internal_edges: internalEdges };
    })
    .sort((a, b) => b.size - a.size || b.strength - a.strength);

  console.log(`Found ${autocatalyticSets.length} autocatalytic sets`);

  const energy = getGitEnergy(allFiles);
  const highEnergy = allFiles
    .filter(f => (energy.get(f) || {}).score >= 0.6)
    .map(f => ({ file: f, ...energy.get(f) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  const lowEnergy = allFiles
    .filter(f => {
      const e = energy.get(f) || { score: 0, commits: 0 };
      return e.commits > 0 && e.score < 0.1;
    })
    .map(f => ({ file: f, ...energy.get(f) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 30);

  const parasites = detectParasites(adjacency, reverseAdj, energy);

  const report = {
    timestamp: new Date().toISOString(),
    autocatalytic_sets: autocatalyticSets,
    high_energy: highEnergy,
    low_energy_candidates: lowEnergy,
    parasites,
    total_files: allFiles.length,
    total_edges: totalEdges,
    graph_density: allFiles.length > 1
      ? Math.round((totalEdges / (allFiles.length * (allFiles.length - 1))) * 10000) / 10000
      : 0
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(`Report: ${OUTPUT}`);
  console.log(`  Sets: ${autocatalyticSets.length} | High-E: ${highEnergy.length} | Low-E: ${lowEnergy.length} | Parasites: ${parasites.length}`);
}

main();
