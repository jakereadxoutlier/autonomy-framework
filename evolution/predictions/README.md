# Prediction-Error Tracking Engine

Predictive processing for the evolution engine. Each tick predicts what the next tick will observe, then the next tick evaluates predictions against reality.

## How It Works

### Predict Mode
```bash
node evolution/prediction-engine.js predict
```
- Snapshots current state: file counts in key dirs, mtimes/sizes for important files, pending request count
- Reads recent tick-log entries to detect patterns (subagent dispatches, bridge activity)
- Writes predictions to `predictions/tick-predictions.json`:
  - Directory file count predictions (per monitored dir)
  - File change predictions (which files will be modified)
  - Bridge activity (expected new requests and responses)
  - Subagent outputs (expected count)
  - Narrative prediction (what the next tick will likely focus on)

### Evaluate Mode
```bash
node evolution/prediction-engine.js evaluate
```
- Reads previous predictions from `tick-predictions.json`
- Compares against current actual state
- Computes per-source accuracy scores
- Appends results to `error-log.jsonl`
- Updates trust scores in `precision.json`
- Prints summary to stdout

## Files

| File | Purpose |
|------|---------|
| `tick-predictions.json` | Current predictions (overwritten each predict cycle) |
| `error-log.jsonl` | Append-only log of all prediction evaluations |
| `precision.json` | Per-source trust scores, updated by evaluate mode |

## Integration

Call from the evolution tick loop:
1. Start of tick: `node prediction-engine.js evaluate` (compare last tick's predictions to reality)
2. End of tick: `node prediction-engine.js predict` (predict what next tick will see)

## Trust Scores

`precision.json` tracks per-source trust (0.0 to 1.0):
- `file_counts` — accuracy of directory file count predictions
- `bridge_activity` — accuracy of request/response count predictions
- `subagent_outputs` — accuracy of subagent output predictions
- `journal_growth` — accuracy of tick-journal change predictions
- `nerve_activity` — accuracy of nerve directory predictions

Trust scores update with a learning rate of 0.1 per evaluation, giving recent accuracy more weight while maintaining historical calibration.

## Relationship to predictive-coding/

The `predictive-coding/predict.js` system operates at the raw filesystem level (individual file sizes, mtimes). This engine operates one level higher — predicting semantic tick outcomes (bridge activity, subagent dispatches, frontier focus). They complement each other: low-level surprise signals from `predictive-coding/` could eventually inform confidence scores here.
