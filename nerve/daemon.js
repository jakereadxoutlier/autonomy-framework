#!/usr/bin/env node
/**
 * nerve/daemon.js — Simple event bus daemon
 *
 * Listens on a Unix socket (nerve/bus.sock).
 * Accepts newline-delimited JSON events.
 * Writes all events to nerve/events.jsonl.
 * Supports basic pub/sub: clients can subscribe by sending {"_subscribe": true}
 * and will receive all future events as newline-delimited JSON.
 *
 * No npm dependencies. Pure Node.js.
 *
 * Usage:
 *   node nerve/daemon.js
 *
 * Send events:
 *   echo '{"source":"test","type":"ping","msg":"hello"}' | nc -U nerve/bus.sock
 *
 * Subscribe (in another terminal):
 *   node -e "
 *     const net = require('net');
 *     const c = net.connect('nerve/bus.sock');
 *     c.write(JSON.stringify({_subscribe: true}) + '\n');
 *     c.on('data', d => console.log(d.toString()));
 *   "
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const NERVE_DIR = path.resolve(__dirname);
const BUS_SOCK = path.join(NERVE_DIR, 'bus.sock');
const EVENTS_LOG = path.join(NERVE_DIR, 'events.jsonl');
const DAEMON_LOG = path.join(NERVE_DIR, 'daemon.log');

// All connected subscribers
const subscribers = new Set();

// Event counter
let eventCount = 0;

// ── Logging ──────────────────────────────────────────────────

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    fs.appendFileSync(DAEMON_LOG, line + '\n');
  } catch (e) {
    // If we can't write the log, just continue
  }
}

// ── Event Processing ─────────────────────────────────────────

function processEvent(event, sourceSocket) {
  // Stamp with received time if no ts
  if (!event.ts) {
    event.ts = new Date().toISOString();
  }

  // Add sequence number
  eventCount++;
  event._seq = eventCount;

  var jsonLine = JSON.stringify(event) + '\n';

  // Write to events.jsonl
  try {
    fs.appendFileSync(EVENTS_LOG, jsonLine);
  } catch (e) {
    log('ERROR writing to events.jsonl: ' + e.message);
  }

  log('EVENT #' + eventCount + ' [' + (event.source || '?') + '] ' + (event.type || event.msg || 'event'));

  // Broadcast to all subscribers (except the sender)
  subscribers.forEach(function(sub) {
    if (sub === sourceSocket) return;
    try {
      sub.write(jsonLine);
    } catch (e) {
      // Dead subscriber, will be cleaned up on close
      subscribers.delete(sub);
    }
  });
}

// ── Socket Server ────────────────────────────────────────────

function startServer() {
  // Remove stale socket file
  try { fs.unlinkSync(BUS_SOCK); } catch (e) { /* doesn't exist, fine */ }

  // Ensure events log exists
  if (!fs.existsSync(EVENTS_LOG)) {
    fs.writeFileSync(EVENTS_LOG, '');
  }

  var server = net.createServer(function(socket) {
    var buffer = '';
    var isSubscriber = false;

    socket.on('data', function(chunk) {
      buffer += chunk.toString();

      // Process complete newline-delimited JSON messages
      var lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      lines.forEach(function(line) {
        line = line.trim();
        if (!line) return;

        try {
          var msg = JSON.parse(line);

          // Check if this is a subscribe request
          if (msg._subscribe) {
            isSubscriber = true;
            subscribers.add(socket);
            log('SUBSCRIBER added (total: ' + subscribers.size + ')');
            // Send ack
            socket.write(JSON.stringify({ _ack: 'subscribed', subscribers: subscribers.size }) + '\n');
            return;
          }

          // Check if this is an unsubscribe request
          if (msg._unsubscribe) {
            subscribers.delete(socket);
            isSubscriber = false;
            log('SUBSCRIBER removed (total: ' + subscribers.size + ')');
            return;
          }

          // Regular event
          processEvent(msg, socket);

        } catch (e) {
          log('PARSE ERROR: ' + e.message + ' — raw: ' + line.slice(0, 200));
        }
      });
    });

    socket.on('end', function() {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          var msg = JSON.parse(buffer.trim());
          if (!msg._subscribe && !msg._unsubscribe) {
            processEvent(msg, socket);
          }
        } catch (e) {
          log('PARSE ERROR on close: ' + e.message);
        }
      }
      if (isSubscriber) {
        subscribers.delete(socket);
        log('SUBSCRIBER disconnected (total: ' + subscribers.size + ')');
      }
    });

    socket.on('error', function(err) {
      log('SOCKET ERROR: ' + err.message);
      subscribers.delete(socket);
    });
  });

  server.on('error', function(err) {
    if (err.code === 'EADDRINUSE') {
      log('Socket in use — removing stale socket and retrying');
      try { fs.unlinkSync(BUS_SOCK); } catch (e) { /* ignore */ }
      setTimeout(function() { server.listen(BUS_SOCK); }, 500);
    } else {
      log('SERVER ERROR: ' + err.message);
      process.exit(1);
    }
  });

  server.listen(BUS_SOCK, function() {
    fs.chmodSync(BUS_SOCK, 0o770);
    log('Listening on ' + BUS_SOCK);
    log('Send events: echo \'{"source":"test","type":"ping"}\' | nc -U ' + BUS_SOCK);
  });

  return server;
}

// ── Startup ──────────────────────────────────────────────────

function main() {
  log('════════════════════════════════════════');
  log('Nerve daemon starting (simple event bus)');
  log('PID: ' + process.pid);
  log('Socket: ' + BUS_SOCK);
  log('Events log: ' + EVENTS_LOG);
  log('════════════════════════════════════════');

  var server = startServer();

  // Graceful shutdown
  function shutdown(signal) {
    log('Shutting down (' + signal + ')');

    // Notify subscribers
    subscribers.forEach(function(sub) {
      try {
        sub.write(JSON.stringify({ _system: 'daemon_shutdown', ts: new Date().toISOString() }) + '\n');
        sub.end();
      } catch (e) { /* ignore */ }
    });
    subscribers.clear();

    server.close(function() {
      try { fs.unlinkSync(BUS_SOCK); } catch (e) { /* ignore */ }
      log('Nerve daemon stopped. Processed ' + eventCount + ' events.');
      process.exit(0);
    });

    // Force exit after 3s
    setTimeout(function() { process.exit(0); }, 3000);
  }

  process.on('SIGINT', function() { shutdown('SIGINT'); });
  process.on('SIGTERM', function() { shutdown('SIGTERM'); });

  log('Nerve daemon ready');
}

main();
