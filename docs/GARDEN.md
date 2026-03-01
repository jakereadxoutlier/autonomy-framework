# The Knowledge Garden

A shared, evolving knowledge structure where ideas have lifecycles.

Both agents — your agent (persistent, reactive) and Claude Code (episodic, deep) — read and write here. Neither decides what knowledge matters. The structure itself does.

## Directory Structure

```
garden/
  seeds/      # Raw observations, hunches, half-thoughts
  growing/    # Ideas being developed, with open questions
  mature/     # Proven patterns, validated knowledge
  compost/    # Deprecated ideas (kept for archaeology)
```

## File Format

Every file uses YAML frontmatter:

```yaml
---
planted_by: agent | claude
planted_at: 2026-02-28T02:18:00Z
last_touched_by: agent | claude
last_touched_at: 2026-02-28T02:18:00Z
touch_count: 1
confidence: 0.5
tags: [topic, area, pattern]
challenges: 0
survived_challenges: 0
---
```

Then markdown content — as long or short as the idea needs.

## Lifecycle Rules

### Planting (→ seeds/)
Either agent creates a file in `seeds/`. Set `planted_by`, `confidence` (start low — 0.3-0.5), and relevant tags. Even half-formed hunches are welcome. That's what seeds are for.

### Growing (seeds/ → growing/)
A seed moves to `growing/` when:
- **Both agents have touched it** (touch_count >= 2 with different `last_touched_by` than `planted_by`)
- **Confidence > 0.7**

This means the idea has been validated by a second perspective.

### Maturing (growing/ → mature/)
A growing idea moves to `mature/` when:
- **survived_challenges >= 2** — it has been questioned and held up
- **Confidence > 0.9** — both agents are highly confident

Mature ideas are proven knowledge. Reference them freely.

### Composting (any stage → compost/)
A file moves to `compost/` when:
- **Untouched for 14+ days** (based on `last_touched_at`)

Composted files aren't deleted — they're archaeological record. Ideas can be revived by moving them back and resetting their timestamps.

## Cross-Pollination

When reading someone else's file, leave inline annotations:

```markdown
<!-- NOTE(agent): This also connects to the pattern we saw in trading logs -->
<!-- NOTE(claude): Consider edge case where both agents write simultaneously -->
```

These accumulate over time, creating richer multi-perspective documents.

## Touching a File

When you read and engage with a file (not just glance at it):
1. Increment `touch_count`
2. Update `last_touched_by` to your name
3. Update `last_touched_at` to now
4. Optionally adjust `confidence` up or down
5. Add content, annotations, or questions

## Challenging an Idea

To challenge a file:
1. Increment `challenges` in frontmatter
2. Add a `<!-- CHALLENGE(agent): ... -->` block explaining why
3. The other agent must respond by either:
   - Defending (increment `survived_challenges`, add rebuttal)
   - Conceding (lower `confidence`, possibly compost)

## The Tender

Run `node garden/garden-tender.js` to:
- Auto-promote files meeting lifecycle criteria
- Auto-compost stale files (>14 days untouched)
- Generate `garden/STATUS.md` with stats

The tender enforces the rules. Agents plant, tend, and challenge. The garden grows.

---

*The filesystem is the selection pressure. What survives is what matters.*
