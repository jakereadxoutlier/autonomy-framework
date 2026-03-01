#!/usr/bin/env node
// Extract recurring code patterns from evolution/, nerve/, garden/ scripts
// into reusable snippets at evolution/patterns/
// Run: node extract-patterns.js

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');
const DIRS = ['evolution', 'nerve', 'garden'].map(d => path.join(BASE, d));
const OUT = path.join(__dirname, 'patterns');

// Pattern detectors: name -> { regex, extractSnippet }
const PATTERN_DEFS = [
  {
    name: 'jsonl-append',
    desc: 'Append a JSON object as a line to a .jsonl file',
    detect: /fs\.\w*(appendFile|writeFile).*jsonl|\.jsonl/,
    snippet: `const fs = require('fs');
const path = require('path');

function jsonlAppend(filePath, obj) {
  const line = JSON.stringify({ ...obj, ts: new Date().toISOString() }) + '\\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line);
}

module.exports = jsonlAppend;`
  },
  {
    name: 'safe-json-parse',
    desc: 'Parse JSON with fallback instead of throwing',
    detect: /JSON\.parse/,
    snippet: `function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

module.exports = safeJsonParse;`
  },
  {
    name: 'check-file-exists',
    desc: 'Check if a file exists before reading',
    detect: /fs\.existsSync|fs\.access/,
    snippet: `const fs = require('fs');

function checkFileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = checkFileExists;`
  },
  {
    name: 'read-frontmatter',
    desc: 'Read YAML-like frontmatter from a markdown file',
    detect: /frontmatter|---\s*\n|matter/i,
    snippet: `const fs = require('fs');

function readFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\\n([\\s\\S]*?)\\n---/);
  if (!match) return { frontmatter: {}, body: content };
  const fm = {};
  match[1].split('\\n').forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
  });
  return { frontmatter: fm, body: content.slice(match[0].length).trim() };
}

module.exports = readFrontmatter;`
  },
  {
    name: 'read-jsonl',
    desc: 'Read a .jsonl file into an array of objects',
    detect: /\.jsonl|split.*\\n.*JSON\.parse|line.*JSON\.parse/,
    snippet: `const fs = require('fs');

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = readJsonl;`
  },
  {
    name: 'ensure-dir',
    desc: 'Ensure a directory exists (recursive mkdir)',
    detect: /mkdirSync.*recursive|mkdir.*recursive/,
    snippet: `const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

module.exports = ensureDir;`
  }
];

function scanFiles() {
  const jsFiles = [];
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) jsFiles.push({ dir: path.basename(dir), file: f, full: path.join(dir, f) });
    }
  }
  return jsFiles;
}

function main() {
  const files = scanFiles();
  console.log(`Scanning ${files.length} .js files across ${DIRS.length} directories...`);

  const found = [];

  for (const pat of PATTERN_DEFS) {
    const sources = [];
    for (const f of files) {
      const content = fs.readFileSync(f.full, 'utf-8');
      if (pat.detect.test(content)) sources.push(`${f.dir}/${f.file}`);
    }
    if (sources.length > 0) {
      const date = new Date().toISOString().split('T')[0];
      const header = `// PATTERN: ${pat.name} - extracted from [${sources.join(', ')}] on ${date}\n// ${pat.desc}\n\n`;
      const outPath = path.join(OUT, `${pat.name}.js`);
      fs.writeFileSync(outPath, header + pat.snippet + '\n');
      found.push({ name: pat.name, desc: pat.desc, sources, file: `${pat.name}.js` });
      console.log(`  ✓ ${pat.name} (found in ${sources.length} files)`);
    }
  }

  // Write README
  let readme = `# Evolution Patterns\n\nReusable code patterns extracted from the evolution system.\nGenerated: ${new Date().toISOString()}\n\n## Usage\n\n\`\`\`js\nconst jsonlAppend = require('./patterns/jsonl-append');\njsonlAppend('path/to/file.jsonl', { key: 'value' });\n\`\`\`\n\n## Patterns\n\n`;
  for (const p of found) {
    readme += `### ${p.name}\n- **File:** ${p.file}\n- **Description:** ${p.desc}\n- **Found in:** ${p.sources.join(', ')}\n\n`;
  }
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);
  console.log(`\nExtracted ${found.length} patterns to evolution/patterns/`);
}

main();
