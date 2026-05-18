# Quality baselines

Take a snapshot of the current quality state, then guard against regression.

```bash
shrk quality baseline create [--output sharkcraft/quality-baseline.json] [--html]
shrk quality baseline compare [--baseline <path>] [--fail-on-regression]
                              [--allow-warning-regression] [--min-score <n>]
                              [--report] [--html] [--json]
shrk quality baseline update                  # alias for `baseline create`
shrk quality baseline show [--json] [--html]
```

## What the baseline captures (R10 hardened)

- `qualityScore`, `readinessScore`
- `blockers`, `warnings`
- Per-gate pass state with error/warning counts
- `categoryScores` — coverage axes (`coverage:rules`, …) + readiness
- `driftFindings`, `driftErrors`, `driftWarnings`
- `packSignatures` summary (`verified` / `unverified` / `invalid` / `notChecked`)
- `sharkcraftVersion` and a short `configHash` (first 16 hex chars of the
  sha256 of `sharkcraft.config.ts`) — handy for detecting "the baseline was
  captured against a different config".

## `baseline compare`

Returns deltas in three buckets: `improvements`, `regressions`, `unchanged`.
Now compares **category scores** too, so a coverage regression in a single
axis lights up even when the overall score is unchanged.

| Flag | Effect |
|---|---|
| `--fail-on-regression` | Non-zero exit if any regression appears |
| `--allow-warning-regression` | Don't count `warning`-bucket gate regressions as failures |
| `--min-score <n>` | Non-zero exit if current `qualityScore` falls below the threshold |
| `--report` | Write `quality-baseline-comparison.md` next to the baseline file |
| `--html` | Write `quality-baseline-comparison.html` (self-contained) |
| `--json` | Emit the full comparison as JSON to stdout |

## `baseline show`

Prints the saved baseline (text by default, `--json` or `--html` to switch
formats). Useful in CI before-and-after diffs.

## `baseline diff` (R11)

```bash
shrk quality baseline diff <old.json> <new.json> [--json]
```

Compares two saved baseline JSON files directly (no live capture). Returns
`scoreDelta`, `blockersDelta`, `warningsDelta`, per-category deltas,
resolved vs. new warnings, signature changes, and a `configHashChanged`
flag.

## `baseline prune` (R11)

```bash
shrk quality baseline prune [--dir <baselineDir>] [--keep N] [--dry-run|--write]
```

Walks a baseline directory (default `.sharkcraft/baselines/`), sorts by
`createdAt`, and keeps the most recent `N` (default 10). Defaults to
dry-run — pass `--write` to actually delete.

## History & aliases (R12)

```bash
shrk quality baseline history [--dir <baselineDir>] [--json]
shrk quality baseline diff latest previous          # alias resolution
shrk quality baseline diff <a.json> latest
```

`history` lists every snapshot in the configured baseline directory
(newest first) with score / blockers / warnings / config-hash /
signature totals. `diff` accepts the literal aliases `latest` and
`previous` so CI can run `shrk quality baseline diff latest previous`
unconditionally.

## MCP

- `get_quality_baseline_comparison` — live comparison (read-only).
- `get_quality_baseline_diff` — file-to-file diff (read-only).
