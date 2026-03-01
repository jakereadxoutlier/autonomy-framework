#!/usr/bin/env node
// webhook.js — HTTP webhook receiver for the nerve bus
// Receives external webhooks (Stripe, GitHub, etc.) and forwards to bus.sock.
// Runs on port 7777 by default.

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.NERVE_WEBHOOK_PORT || '7777', 10);
const NERVE_DIR = path.resolve(__dirname, '..');
const BUS_SOCK = path.join(NERVE_DIR, 'bus.sock');
const NERVE_LOG = path.join(NERVE_DIR, 'nerve.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] [webhook] ${msg}`;
  console.log(line);
  fs.appendFileSync(NERVE_LOG, line + '\n');
}

// Send an event to the nerve bus via Unix socket
function sendToBus(event) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(BUS_SOCK, () => {
      client.write(JSON.stringify(event) + '\n');
      client.end();
      resolve();
    });
    client.on('error', err => {
      log(`BUS ERROR: ${err.message}`);
      reject(err);
    });
    // Timeout after 5s
    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error('timeout'));
    });
  });
}

// Extract source from URL path: /hook/stripe → "stripe"
function sourceFromPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] === 'hook' && parts[1]) return parts[1];
  return 'webhook';
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', bus_sock: fs.existsSync(BUS_SOCK) }));
    return;
  }

  // Only accept POST
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // Collect body
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    const source = sourceFromPath(req.url);
    let payload;

    try {
      payload = JSON.parse(body);
    } catch {
      // If not JSON, wrap the raw body
      payload = { raw: body };
    }

    const event = {
      source,
      type: payload.type || payload.event || 'webhook',
      ...payload,
      _webhook: {
        path: req.url,
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
          'x-github-event': req.headers['x-github-event'],
          'stripe-signature': req.headers['stripe-signature'] ? '[present]' : undefined,
        },
        received: new Date().toISOString()
      },
      ts: Date.now()
    };

    try {
      await sendToBus(event);
      log(`OK: ${source} ${event.type} → bus`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    } catch (err) {
      log(`FAIL: Could not send to bus: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bus unavailable' }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Webhook sensor listening on http://127.0.0.1:${PORT}`);
  log(`Endpoints: POST /hook/<source> (e.g. /hook/stripe, /hook/github)`);
});

server.on('error', err => {
  log(`SERVER ERROR: ${err.message}`);
  process.exit(1);
});
