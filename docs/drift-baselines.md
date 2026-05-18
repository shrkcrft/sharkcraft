# Drift baselines

Accept the drift that exists today; gate only on *new* drift.

```bash
shrk drift baseline create
shrk drift baseline compare [--fail-on-new-drift]
shrk drift baseline update
```

Findings are fingerprinted by `category | severity | ruleId | file | message`.
Compare buckets findings into `existing`, `newFindings`, `resolved`.

The `quality --require-drift-clean` gate can be combined with a baseline so
only newly introduced findings count as a regression.
