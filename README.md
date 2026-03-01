# Autonomy Framework

**Turn any AI into an autonomous agent that works while you sleep.**

---

## What This Is

Autonomy Framework is a zero-dependency Node.js framework for building autonomous AI agents. It gives your AI persistent memory, autonomous task execution, self-monitoring, and self-improvement -- all through the filesystem and standard Unix primitives. No databases. No message brokers. No vendor lock-in. Just files, sockets, and processes.

This framework was built and battle-tested running a 24/7 AI agent called [Halo](https://github.com/jakereadxoutlier) on top of [OpenClaw](https://github.com/jakereadxoutlier). The architecture works with any AI CLI (Claude Code, GPT wrappers, local models) and any orchestration layer (chatbots, cron jobs, APIs, Telegram bots). You write a markdown file. The agent does the work.

How capable is an agent running this framework? In a single day, the agent this powers: read 36 research papers, built 3 new analysis tools from scratch, detected and fixed its own bugs, tracked its own prediction accuracy, and composted stale ideas from its knowledge garden -- all without a single human prompt. The tick loop ran. The agent decided what mattered. It did the work. It validated the results. Then it did it again.

## Architecture

Three layers. Each one works independently. Together they create a self-improving autonomous loop.

```
+------------------------------------------+
|   Your Agent (chatbot, cron, API, bot)   |
|       writes .md files to requests/      |
+------------------+-----------------------+
                   |
                   v
+------------------------------------------+
|          Bridge Daemon                   |
|   watches requests/, spawns AI CLI,      |
|   writes responses/, OOM protection      |
+------------------+-----------------------+
                   |
                   v  emits events
+------------------------------------------+
|          Nerve Bus                        |
|   Unix socket, priority routing,         |
|   sensors, cascades, batching            |
+------------------+-----------------------+
                   |
                   v  triggers
+------------------------------------------+
|          Evolution Engine                 |
|   tick loop: assess -> decide -> do ->   |
|   validate -> learn -> repeat            |
+------------------------------------------+
```

**Bridge Protocol** is the interface. Drop a `.md` file, get work done.
**Nerve System** is the nervous system. Events flow, get classified, trigger responses.
**Evolution Engine** is the brain. It decides what to work on next, validates results, and learns from outcomes.

## Key Components

### Bridge Daemon
`evolution/bridge-daemon.js`

Watches `evolution/requests/` for markdown files with `**Status:** pending`. When one appears, it spawns your AI CLI (`claude -p` by default) with the request content and full workspace access. The AI does the work. The bridge writes the response to `evolution/responses/`.

- **Priority queuing**: P0 requests get processed first
- **OOM protection**: Monitors child process RSS every 5 seconds, kills at 1.5GB
- **Timeout handling**: 20-minute max per request, captures partial output
- **Retry logic**: OOM'd requests get retried once with a minimal prompt
- **Deliverable validation**: Checks that files mentioned in responses actually exist on disk

### Nerve System
`nerve/nerve-daemon.js`

An event bus over Unix sockets. Any process can emit events by writing JSON to the socket. The nerve daemon classifies them by priority and routes accordingly.

| Priority | Behavior | Example |
|----------|----------|---------|
| P0 | Immediate wake -- agent gets notified now | Payment failure, security alert |
| P1 | Batched (30s window) -- bundled for efficiency | Git pushes, team emails |
| P2 | Batched (5 min window) -- low-urgency digest | Health checks, routine crons |
| P3 | Log only -- stored in stream, no notification | File changes |
| P4 | Log only -- pure telemetry | Default catch-all |

Features: event deduplication (60s window), throttling (100 events/min max), cascade rules (one event triggers others), live config reload, self-scheduling.

### Evolution Engine
`evolution/evolve.sh` + supporting scripts

The autonomous loop. Runs on a cron schedule (or manually). Each tick:

1. **Assess** -- `generate-state.sh` builds a snapshot of the agent's current state
2. **Detect gaps** -- `gap-builder.js` finds what's missing, broken, or underperforming
3. **Generate requests** -- `gap-processor.js` turns gaps into bridge requests
4. **Execute** -- Bridge daemon processes the requests
5. **Validate** -- `validator.js` checks that deliverables are real
6. **Learn** -- Results feed back into predictions and the knowledge garden

### Knowledge Garden
`garden/garden-tender.js`

Ideas have a lifecycle. They are not stored -- they grow.

- **Seeds**: Raw ideas, hypotheses, observations. Just planted.
- **Growing**: Ideas that have been acted on. Evidence accumulating.
- **Mature**: Validated ideas with proven value. Referenced by other components.
- **Compost**: Ideas that didn't work out. Auto-composted after 7 days of inactivity. Not deleted -- decomposed back into nutrients for new ideas.

The garden tender runs periodically, promoting ideas with high confidence scores and composting stale ones. Cross-pollination detection finds connections between ideas the agent didn't explicitly make.

### Prediction Engine
`evolution/prediction-engine.js`

Before each tick, the agent predicts what will happen. After the tick, it measures what actually happened. Over time, this builds a calibration curve: the agent learns what it is good at predicting and what it is not.

Trust scores adjust automatically. High-confidence predictions that keep failing get downweighted. Surprising successes get investigated. The agent develops genuine self-awareness about its own capabilities.

### Autocatalytic Set Detector
`evolution/autocatalytic-set-detector.js`

Uses Tarjan's strongly-connected-components algorithm to find self-referential loops in the codebase. When file A references B, B references C, and C references A -- that is an autocatalytic set. A self-maintaining loop.

This matters because it detects when the system transitions from "a collection of scripts" to "a self-maintaining organism." The more autocatalytic sets, the more the system sustains itself without external input.

### Morphogen Gradient
`evolution/morphogen-gradient.js`

Borrowed from biology. Morphogens are chemical gradients that tell cells what to become during development. This maps the same concept onto directories.

Each directory zone gets scored on event density (how much is happening) and success rate (how well it is going). The gradient tells the evolution engine where to invest attention:

- **Expand**: High success, high activity -- this area is working, grow it
- **Optimize**: High activity, lower success -- lots of effort, not enough payoff
- **Stable**: Low activity, high success -- working fine, leave it alone
- **Dormant**: Low everything -- maybe deprecated, maybe waiting for its moment

## Quick Start

```bash
git clone https://github.com/YOUR-REPO/autonomy-framework
cd autonomy-framework
./install.sh ~/my-agent
```

The install script:
1. Creates the directory structure under `~/my-agent/` (evolution, nerve, garden, etc.)
2. Copies config files and sets up defaults
3. Installs macOS LaunchAgents for the bridge daemon and nerve system
4. Makes everything executable

Then submit your first task:

```bash
# Drop a request file
cat > ~/my-agent/evolution/requests/hello.md << 'EOF'
# Task: Hello World

- **From:** human
- **Priority:** P2-normal
- **Type:** experiment
- **Status:** pending

## Context
First test of the autonomy framework.

## Desired Outcome
Create a file ~/my-agent/hello.txt that says "The agent is alive."

## Acceptance Criteria
The file exists and contains the expected text.
EOF

# Watch it get picked up
tail -f ~/my-agent/evolution/bridge.log
```

Within 10 seconds, the bridge daemon detects the file, marks it `in-progress`, spawns the AI CLI, and starts working. When it finishes, you will see the response in `~/my-agent/evolution/responses/hello.md` and the request file updated to `**Status:** completed`.

## How It Works (Step by Step)

```
1. You (or your chatbot, or a cron job) write a .md file
   to evolution/requests/ with **Status:** pending

2. Bridge daemon detects it (polls every 10 seconds)

3. Bridge marks it **Status:** in-progress and spawns:
   claude -p "handle this request" --output-format text
   with full workspace access

4. The AI CLI does the actual work:
   creates files, runs commands, writes code, whatever the
   request asked for

5. Bridge captures stdout, validates deliverables,
   writes response to evolution/responses/

6. Bridge marks the request **Status:** completed or **Status:** failed

7. Nerve events fire:
   bridge.completed, bridge.failed, bridge.oom, bridge.timeout

8. Evolution engine (if running) picks up the signal,
   validates results, updates predictions, tends the garden
```

The whole thing is intentionally simple. Markdown in, work done, markdown out. Every state transition is visible as a file on disk. You can debug the entire system with `ls` and `cat`.

## Configuration

Copy the example config and edit it:

```bash
cp config.example.json ~/my-agent/config.json
```

```json
{
  "agent_name": "my-agent",
  "agent_home": "~/my-agent",
  "claude_bin": "claude",
  "bridge": {
    "poll_interval_ms": 10000,
    "max_request_timeout_ms": 1200000,
    "oom_limit_mb": 1500
  },
  "nerve": {
    "socket_path": "nerve/bus.sock",
    "webhook_port": 7777
  },
  "garden": {
    "compost_after_days": 7,
    "promotion_confidence": 0.7
  }
}
```

For attention routing rules, see `examples/attention.example.json`. For cascade rules (event A triggers event B), see `examples/cascades.example.json`.

## Task Server API

For programmatic access, the task server provides an HTTP API on port 4247:

```bash
# Submit a task
curl -X POST http://127.0.0.1:4247/task \
  -H "Content-Type: application/json" \
  -d '{"title":"Analyze logs","body":"Find error patterns in the last 24h","priority":"P2-normal"}'

# Check task status
curl http://127.0.0.1:4247/task/task-xxx

# List all tasks
curl http://127.0.0.1:4247/tasks

# Health check
curl http://127.0.0.1:4247/health
```

The task server creates request files for the bridge daemon automatically, tracks status, and emits nerve events on completion. This is the preferred integration point for bots and external services.

## Requirements

- **macOS** (Linux support planned -- LaunchAgent plists need systemd equivalents)
- **Node.js 18+**
- **Claude Code CLI** (`npm install -g @anthropic-ai/claude-code`) or any AI CLI that accepts piped prompts
- **An Anthropic API key** (or equivalent for your AI provider)

## Project Structure

```
autonomy-framework/
|
|-- evolution/                    # The autonomous loop
|   |-- bridge-daemon.js          # File-based job queue, spawns AI CLI
|   |-- task-server.js            # HTTP API for submitting tasks
|   |-- evolve.sh                 # Main tick loop orchestrator
|   |-- gap-builder.js            # Detects what's missing or broken
|   |-- gap-processor.js          # Turns gaps into actionable requests
|   |-- prediction-engine.js      # Forecasts and calibrates trust
|   |-- validator.js              # Checks deliverables are real
|   |-- autocatalytic-set-detector.js  # Finds self-maintaining loops
|   |-- morphogen-gradient.js     # Maps growth direction per zone
|   |-- extract-patterns.js       # Mines patterns from history
|   |-- build-knowledge-graph.js  # Connects concepts
|   |-- consolidate.js            # Merges overlapping work
|   |-- dashboard.js              # Web dashboard for monitoring
|   |-- signals/                  # Runtime data (metrics, experiments)
|   |-- predictions/              # Prediction history
|   |-- requests/                 # Incoming task files (.md)
|   |-- responses/                # Completed response files (.md)
|
|-- nerve/                        # Event-driven nervous system
|   |-- nerve-daemon.js           # Unix socket event bus + priority router
|   |-- sensors/
|   |   |-- fs-watch.js           # Filesystem change detection
|   |   |-- webhook.js            # HTTP webhook receiver
|   |   |-- chat-pollution-sensor.sh  # Chat quality monitoring
|   |-- nerve-cli.sh              # CLI for emitting events manually
|   |-- install.sh                # Nerve system installer
|
|-- garden/                       # Knowledge garden
|   |-- garden-tender.js          # Lifecycle management (seed -> compost)
|
|-- examples/                     # Example configurations
|   |-- attention.example.json    # Priority routing rules
|   |-- cascades.example.json     # Event cascade rules
|
|-- docs/                         # Documentation
|   |-- BRIDGE.md                 # Bridge protocol reference
|   |-- GARDEN.md                 # Garden lifecycle reference
|
|-- config.example.json           # Base configuration template
```

## Emitting Events

Any process can send events to the nerve bus. Write JSON to the Unix socket:

```bash
# From the command line
echo '{"source":"my-script","type":"deploy.complete","env":"prod"}' | \
  nc -U ~/my-agent/nerve/bus.sock

# Or use the included CLI
./nerve/nerve-cli.sh '{"source":"cron","type":"health_check"}'
```

```javascript
// From Node.js
const net = require('net');
const client = net.createConnection('/path/to/nerve/bus.sock', () => {
  client.write(JSON.stringify({
    source: 'my-app',
    type: 'user.signup',
    user_id: '12345'
  }) + '\n');
  client.end();
});
```

The nerve daemon will classify the event, route it by priority, and optionally wake the agent or trigger cascade rules.

## Philosophy

This framework treats the filesystem as the agent's body, not its storage. Files are not data -- they are dynamic organs being continuously shaped. The request directory is a mouth. The response directory is a voice. The nerve bus is proprioception. The knowledge garden is long-term memory with natural decay.

The tick loop is the sensorimotor cycle: perceive the world, decide what matters, act, observe the result, update your model. The prediction engine is metacognition -- the agent thinking about its own thinking. The morphogen gradient is developmental biology -- the system growing toward what works and away from what does not.

Every piece of state is a file you can read with `cat`. Every process communicates through the filesystem or Unix sockets. There is no hidden state, no opaque databases, no magic. If something breaks, you `ls` the directory and read the files. The agent's entire mind is visible at all times.

This is not a framework for building chatbots. This is a framework for building things that work while you are not looking.

## License

MIT

## Credits

Built by [Jake Read](https://github.com/jakereadxoutlier). Powered by Claude. Originally developed as the autonomy layer for Halo, a 24/7 AI agent running on [OpenClaw](https://github.com/jakereadxoutlier).
