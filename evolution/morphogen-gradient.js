#!/usr/bin/env node
// morphogen-gradient.js — Calculates morphogen gradients across the filesystem
// Analyzes nerve event density and success rates per top-level directory zone
// Pure Node.js, no dependencies

const fs = require('fs');
const path = require('path');

const CLAWD_ROOT = path.resolve(__dirname, '..');
const NERVE_EVENTS_DIR = path.join(CLAWD_ROOT, 'nerve', 'events');
const NERVE_STREAM = path.join(CLAWD_ROOT, 'nerve', 'stream.jsonl');
const TICK_LOG = path.join(CLAWD_ROOT, 'evolution', 'signals', 'tick-log.jsonl');
const GRADIENTS_DIR = path.join(__dirname, 'gradients');
const ONE_HOUR_MS = 60 * 60 * 1000;

// Top-level zones to analyze
const ZONES = ['garden', 'nerve', 'skills', 'evolution', 'scripts', 'read-labs', 'projects', 'tectonic-email-bot'];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Read all nerve event files (JSON arrays)
function readEventFiles() {
  const events = [];
  if (!fs.existsSync(NERVE_EVENTS_DIR)) return events;

  try {
    const files = fs.readdirSync(NERVE_EVENTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(NERVE_EVENTS_DIR, file), 'utf8');
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        events.push(...arr);
      } catch (e) {
        // Skip malformed files
      }
    }
  } catch (e) {
    // Directory read failed
  }
  return events;
}

// Read the nerve stream (JSONL)
function readStreamEvents() {
  const events = [];
  if (!fs.existsSync(NERVE_STREAM)) return events;

  try {
    const lines = fs.readFileSync(NERVE_STREAM, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (e) {
    // File read failed
  }
  return events;
}

// Read tick log entries (JSONL)
function readTickLog() {
  const entries = [];
  if (!fs.existsSync(TICK_LOG)) return entries;

  try {
    const lines = fs.readFileSync(TICK_LOG, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (e) {
    // File read failed
  }
  return entries;
}

// Extract timestamp from an event (handles multiple formats)
function getTimestamp(event) {
  if (event.ts && typeof event.ts === 'number') return event.ts;
  if (event.ts && typeof event.ts === 'string') {
    const t = new Date(event.ts).getTime();
    if (!isNaN(t)) return t;
  }
  if (event.timestamp) {
    const t = new Date(event.timestamp).getTime();
    if (!isNaN(t)) return t;
  }
  if (event.time) {
    const t = new Date(event.time).getTime();
    if (!isNaN(t)) return t;
  }
  if (event._nerve && event._nerve.received) return new Date(event._nerve.received).getTime();
  return 0;
}

// Determine which zone an event belongs to based on its content
function classifyEvent(event) {
  const zones = new Set();

  // Check file path references
  const pathStr = event.path || event.file || '';
  if (pathStr) {
    const relPath = pathStr.replace(CLAWD_ROOT + '/', '').replace(/^\/Users\/[^/]+\/\w+\//, '');
    const topDir = relPath.split('/')[0];
    if (ZONES.includes(topDir)) {
      zones.add(topDir);
    }
  }

  // Classify by source
  const source = (event.source || '').toLowerCase();
  const type = (event.type || '').toLowerCase();
  const msg = (event.msg || event.detail || event.title || '').toLowerCase();

  // Source-based classification
  if (source === 'task-server' || source === 'bridge') zones.add('evolution');
  if (source === 'cascade' || source === 'nerve' || source === 'fs') zones.add('nerve');
  if (source === 'stripe' || source === 'email') zones.add('scripts');
  if (source === 'github') zones.add('projects');

  // Type-based classification
  if (type.includes('evolution') || type.includes('task')) zones.add('evolution');
  if (type.includes('nerve') || type.includes('file_changed') || type.includes('file_renamed')) zones.add('nerve');

  // Content-based classification
  for (const zone of ZONES) {
    if (msg.includes(zone)) zones.add(zone);
  }

  // Tick-log entries are always evolution events, but also scan their rich fields
  if (event.tick !== undefined || event.frontier !== undefined) {
    zones.add('evolution');

    // Scan dispatched, built, connections, key_ideas for zone references
    const richFields = [
      JSON.stringify(event.dispatched || ''),
      JSON.stringify(event.built || ''),
      JSON.stringify(event.connections || ''),
      JSON.stringify(event.key_ideas || event.key_idea || ''),
      JSON.stringify(event.integrated || ''),
      event.frontier || '',
      event.topic || '',
    ].join(' ').toLowerCase();

    for (const zone of ZONES) {
      if (richFields.includes(zone)) zones.add(zone);
    }
  }

  // If no zone classified, assign to nerve (system-level events)
  if (zones.size === 0) zones.add('nerve');

  return [...zones];
}

// Determine if an event indicates success or failure
function classifyOutcome(event) {
  const type = (event.type || '').toLowerCase();
  const msg = (event.msg || event.detail || '').toLowerCase();
  const source = (event.source || '').toLowerCase();
  const priority = event._nerve ? event._nerve.priority : 2;

  // Explicit failure indicators
  if (type.includes('fail') || type.includes('error') || type.includes('crash')) return 'failure';
  if (msg.includes('fail') || msg.includes('error') || msg.includes('crash') || msg.includes('timeout')) return 'failure';
  if (type === 'charge.failed') return 'failure';
  if (priority === 0 && type.includes('error')) return 'failure';

  // Explicit success indicators
  if (type.includes('success') || type.includes('complete') || type.includes('verified')) return 'success';
  if (msg.includes('success') || msg.includes('complete') || msg.includes('verified') || msg.includes('alive')) return 'success';
  if (type === 'task.queued') return 'success'; // Successfully queued
  if (event.built || event.builds_verified) return 'success'; // Tick log builds
  if (event.status === 'complete') return 'success'; // Tick completed
  if (event.dispatched) return 'success'; // Active dispatching = progress
  if (event.integrated) return 'success'; // Integrated research = progress

  // Neutral/informational events — count as success (system is working)
  if (type === 'file_changed' || type === 'file_renamed' || type === 'push') return 'success';
  if (type === 'verify' || type === 'install_verify') return 'success';

  // Default: neutral events are mildly positive (system is active)
  return 'neutral';
}

// Determine growth direction from density and success rate
function getGrowthDirection(density, successRate) {
  const highDensity = density >= 0.5;
  const highSuccess = successRate >= 0.5;

  if (highDensity && !highSuccess) return 'optimize';
  if (!highDensity && highSuccess) return 'stable';
  if (highDensity && highSuccess) return 'expand';
  return 'dormant'; // Low density + low success
}

function main() {
  const now = Date.now();
  const cutoff = now - ONE_HOUR_MS;

  // Gather all events from all sources
  const eventFileEvents = readEventFiles();
  const streamEvents = readStreamEvents();
  const tickEntries = readTickLog();

  // Merge and deduplicate by hash if available
  const seenHashes = new Set();
  const allEvents = [];

  for (const event of [...eventFileEvents, ...streamEvents, ...tickEntries]) {
    const hash = event._nerve ? event._nerve.hash : null;
    if (hash && seenHashes.has(hash)) continue;
    if (hash) seenHashes.add(hash);
    allEvents.push(event);
  }

  // Filter to last hour
  const recentEvents = allEvents.filter(e => getTimestamp(e) >= cutoff);

  // If no recent events, use all events (system may have been quiet)
  const eventsToAnalyze = recentEvents.length > 0 ? recentEvents : allEvents;
  const usingAll = recentEvents.length === 0;

  // Count events per zone
  const zoneCounts = {};
  const zoneOutcomes = {};
  for (const zone of ZONES) {
    zoneCounts[zone] = 0;
    zoneOutcomes[zone] = { success: 0, failure: 0, neutral: 0 };
  }

  for (const event of eventsToAnalyze) {
    const zones = classifyEvent(event);
    const outcome = classifyOutcome(event);

    for (const zone of zones) {
      if (!zoneCounts[zone]) {
        zoneCounts[zone] = 0;
        zoneOutcomes[zone] = { success: 0, failure: 0, neutral: 0 };
      }
      zoneCounts[zone]++;
      zoneOutcomes[zone][outcome]++;
    }
  }

  // Normalize density: max count → 1.0
  const maxCount = Math.max(...Object.values(zoneCounts), 1);

  // Build gradient per zone
  const gradients = {};
  ensureDir(GRADIENTS_DIR);

  for (const zone of ZONES) {
    const count = zoneCounts[zone] || 0;
    const outcomes = zoneOutcomes[zone] || { success: 0, failure: 0, neutral: 0 };
    const total = outcomes.success + outcomes.failure + outcomes.neutral;

    const eventDensity = parseFloat((count / maxCount).toFixed(3));

    // Success rate: successes + half of neutrals / total (neutrals partially count)
    let successRate = 0;
    if (total > 0) {
      successRate = parseFloat(((outcomes.success + outcomes.neutral * 0.5) / total).toFixed(3));
    }

    const growthDirection = getGrowthDirection(eventDensity, successRate);

    const gradient = {
      zone,
      event_density: eventDensity,
      success_rate: successRate,
      growth_direction: growthDirection,
      raw: {
        event_count: count,
        successes: outcomes.success,
        failures: outcomes.failure,
        neutrals: outcomes.neutral,
      },
      computed_at: new Date().toISOString(),
      window: usingAll ? 'all_time' : 'last_1h',
    };

    gradients[zone] = gradient;

    // Write individual zone file
    const filePath = path.join(GRADIENTS_DIR, `${zone}.json`);
    fs.writeFileSync(filePath, JSON.stringify(gradient, null, 2) + '\n');
  }

  // Write overview
  const overview = {
    computed_at: new Date().toISOString(),
    window: usingAll ? 'all_time' : 'last_1h',
    total_events_analyzed: eventsToAnalyze.length,
    total_events_available: allEvents.length,
    zones: gradients,
  };

  fs.writeFileSync(
    path.join(GRADIENTS_DIR, 'overview.json'),
    JSON.stringify(overview, null, 2) + '\n'
  );

  // Print summary to stdout
  console.log('=== Morphogen Gradient Report ===');
  console.log(`Window: ${usingAll ? 'all time (no recent events)' : 'last 1 hour'}`);
  console.log(`Events analyzed: ${eventsToAnalyze.length} / ${allEvents.length} total`);
  console.log('');

  const sortedZones = Object.values(gradients).sort((a, b) => b.event_density - a.event_density);
  for (const g of sortedZones) {
    const bar = '█'.repeat(Math.round(g.event_density * 20)).padEnd(20, '░');
    const dir = g.growth_direction.padEnd(8);
    console.log(`  ${g.zone.padEnd(22)} ${bar} density=${g.event_density.toFixed(2)}  success=${g.success_rate.toFixed(2)}  → ${dir}`);
  }

  console.log('');
  console.log(`Gradients written to: ${GRADIENTS_DIR}/`);
}

main();
