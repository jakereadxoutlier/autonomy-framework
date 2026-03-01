#!/bin/bash
cd ${AGENT_HOME:-$HOME/autonomy} && git add evolution/ garden/ SOUL.md AGENTS.md MEMORY.md && git diff --cached --quiet || git commit -m "evolution: auto-commit $(date +%Y-%m-%dT%H%M)"
