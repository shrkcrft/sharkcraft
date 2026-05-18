# CI integrity report

R31 ships a single aggregator for the JSON reports the CI scaffold writes.

## Commands

```bash
shrk ci report [--reports-dir <dir>] [--format text|markdown|html|json] [--output <file>] [--fail-on error|warning|none]
```

Defaults: `--reports-dir .sharkcraft/reports`, `--format text`,
`--fail-on error`.

## Input gates

- `knowledge-stale.json` — required-stale / required-missing counts
- `template-drift.json` — pass / warn / fail
- `boundaries.json` — violations
- `safety-audit.json` — passed + errors/warnings
- `agent-tests.json` — passed / failed / total
- `product.json` — errors/warnings
- `commands-doctor.json` — passed + errors/warnings
- `release-readiness.json` — passed / ready + errors

## Output

- Overall verdict: `pass | warn | fail | unknown`
- Per-gate status with summary and `nextCommand`
- Top failing gates and `nextCommands`

## Schema

`sharkcraft.ci-integrity/v1`.

## MCP

`get_ci_integrity_report` — read-only.
