# Doctor: code-intelligence checks

This is the authoritative reference for the 14 doctor checks under
`category: 'code-intelligence'`. Each check is contributed by
`buildCodeIntelligenceChecks(projectRoot)` in
`packages/inspector/src/code-intelligence-doctor.ts` and surfaces in
the standard `shrk doctor` output.

> Inspector deliberately does **not** depend on any code-intelligence
> package. Every check reads its source-of-truth file directly from
> `inspection.projectRoot` with a locally-redeclared minimal JSON
> shape, so an uninstalled add-on stays silent rather than breaking
> doctor.

## At a glance

| Check id | Source file | Triggers | Default severity |
|---|---|---|---|
| `code-intelligence-graph` | `.sharkcraft/graph/meta.json` | missing / stale / corrupt / fresh | Info / Warning advisory / Warning / Ok |
| `code-intelligence-graph-cycles` | same | `largestCycleSize ≥ 3` OR `cycleCount ≥ 5` | Warning advisory |
| `code-intelligence-graph-unresolved` | same | `unresolvedImportCount > 0` | Warning |
| `code-intelligence-rule-graph` | `.sharkcraft/bridge/meta.json` | stale / corrupt / fresh | Warning advisory / Warning / Ok |
| `code-intelligence-rule-coverage` | same | uncovered ratio > 50% | Warning advisory |
| `code-intelligence-api-surface` | `.sharkcraft/api-surface/signatures.json` | stale | Warning advisory / Ok |
| `code-intelligence-quality-gate` | `.sharkcraft/quality-gates/last.json` | overall = fail / warn / pass | Warning / Info advisory / Ok |
| `code-intelligence-migrations` | `.sharkcraft/migrations/*.state.json` | any `overall = fail` | Warning |
| `code-intelligence-architecture` | `.sharkcraft/architecture/{baseline,last}.json` | new violations since baseline | Warning |
| `code-intelligence-impact` | `.sharkcraft/impact/last.json` | risk = high/critical | Warning |
| `code-intelligence-impact-baseline` | `.sharkcraft/impact/{baseline,last}.json` | dependents / packages / risk worsened | Warning |
| `code-intelligence-framework` | `.sharkcraft/framework/meta.json` | stale / zero-entity / corrupt / fresh | Warning advisory / Info advisory / Warning / Ok |
| `code-intelligence-structural-search` | `.sharkcraft/structural/patterns.json` | invalid entries / empty / unvalidated / valid | Warning / Info advisory / Ok |
| `code-intelligence-context-planner` | `.sharkcraft/context-planner/intent-benchmark.json` | accuracy < 80% / any miss / 100% | Warning / Warning advisory / Ok |
| `code-intelligence-schema-mismatch` | cross-store | any stored payload uses a schema version inspector doesn't recognise | Warning |

## Severity model

| Severity | Meaning |
|---|---|
| `Ok` | check passed |
| `Info` | informational — nothing to fix |
| `Info` + `advisory` | nudge — feature is opt-in, no health risk |
| `Warning` + `advisory` | something has decayed but doesn't block use |
| `Warning` (no advisory) | real DX issue — fix recommended |
| `Error` | (none in this category — code-intelligence is non-blocking) |

`--strict=warnings` excludes advisory warnings from the failure count.
`--strict=all` counts them. `--hide code-intelligence` mutes the
whole section in the headline.

## Per-check details

### `code-intelligence-graph` + `-graph-cycles` + `-graph-unresolved`

**Source:** `.sharkcraft/graph/meta.json` (schema `sharkcraft.graph/v1`).

The graph check is the load-bearing freshness signal — every other
code-intelligence check depends on the graph being current.

- `code-intelligence-graph`
  - `Info` when the file is missing — agent reads still work but
    `shrk impact`, `shrk graph callers`, and the context planner
    fall back to slower scans. Fix: `shrk graph index`.
  - `Ok` when the file is recent (within `staleThresholdDays`,
    default 7). Message reports file / node / edge counts plus the
    inline cycle tag and unresolved-import count when non-zero.
  - `Warning` + `advisory` when stale. Fix: `shrk graph index
    --changed` (or `--full`).
  - `Warning` (structural, not advisory) when the file exists but
    isn't valid JSON. Fix: `shrk graph index --full`.

- `code-intelligence-graph-cycles`
  - Fires when `largestCycleSize ≥ 3` OR `cycleCount ≥ 5`. The
    thresholds exist so small 2-file cycles (which often come and go
    during refactors) don't generate permanent yellow noise. The
    advisory severity matches: cycles ARE a real refactor target but
    they're rarely "fix today" issues.
  - Fix: `shrk graph cycles` lists every SCC; `shrk arch check`
    surfaces them as graded `cycle` violations.

- `code-intelligence-graph-unresolved`
  - Fires whenever `unresolvedImportCount > 0`. **Not advisory** —
    unresolved imports are usually real bugs (typos, deleted files,
    alias renames the importer never followed). The doctor shows
    the first three sample specifiers in the message.
  - Fix: `shrk graph unresolved` enumerates every broken import
    grouped by source file. The MCP equivalent is
    `get_graph_unresolved`.

### `code-intelligence-rule-graph` + `-rule-coverage`

**Source:** `.sharkcraft/bridge/meta.json` (schema
`sharkcraft.rule-graph/v1`).

The rule-graph bridge maps code files to applicable rules. It builds
alongside `shrk graph index` so the freshness model matches.

- `code-intelligence-rule-graph`
  - Silent when no bridge has been built (downstream of graph).
  - `Ok` when fresh, `Warning` + `advisory` when stale.

- `code-intelligence-rule-coverage`
  - The bridge builder tracks `filesCoveredByRules` /
    `filesUncoveredByRules` based on `applies-rule` edges from
    boundaries + knowledge rules (paths and templates excluded —
    those signal location / generation, not policy).
  - Fires `Warning` + `advisory` when `filesUncoveredByRules /
    filesTotal > 50%`. A growing gap usually means the rule registry
    is drifting behind the codebase.
  - Fix: `shrk rules where applies-to <file>` inspects coverage for
    a specific file; broaden a rule's `appliesTo` glob or boundary
    `from` list to extend coverage.

### `code-intelligence-api-surface`

**Source:** `.sharkcraft/api-surface/signatures.json` (schema
`sharkcraft.api-surface-cache/v1`).

The signature cache speeds up `shrk api-diff --with-signatures`. Stale
cache means real signature-changed findings get missed.

- `Ok` when fresh; `Warning` + `advisory` past
  `staleThresholdDays`. Fix: `shrk api-diff --with-signatures`.

### `code-intelligence-quality-gate`

**Source:** `.sharkcraft/quality-gates/last.json` (schema
`sharkcraft.quality-gate-report/v1`).

Written by `shrk gate`. Doctor surface tracks the last run's outcome.

- `Ok` on `overall = pass`.
- `Warning` (not advisory) on `overall = fail` with failing gate
  ids in the message. Fix: `shrk gate`.
- `Info` + `advisory` on `warn / skipped / unknown`.

### `code-intelligence-migrations`

**Source:** `.sharkcraft/migrations/*.state.json` (schema
`sharkcraft.migration-run/v1`).

Every failed `shrk migrate apply` leaves a checkpoint on disk so the
user can resume from the failed step. Doctor flags them so they don't
linger silently.

- `Warning` (not advisory) when any state file has `overall = fail`.
  Fix: `shrk migrate resume <id>` or `shrk migrate prune
  --include-failed`.

### `code-intelligence-architecture`

**Source:** `.sharkcraft/architecture/{baseline,last}.json` (schema
`sharkcraft.architecture-snapshot/v1`).

`shrk arch check` auto-writes `last.json` after every run.
`shrk arch baseline write` freezes the current set as `baseline.json`.

- `Ok` on `last violations ⊆ baseline violations` (no new ids).
- `Warning` on any new violation id, with the first three samples in
  the message + error / warning count delta. Fix: investigate the new
  violations; if intentional, re-freeze with `shrk arch baseline
  write`.
- `Info` when only one side is present (nudges the missing command).

### `code-intelligence-impact` + `-impact-baseline`

**Source:** `.sharkcraft/impact/{last,baseline}.json` (schema
`sharkcraft.impact-run/v1`).

`shrk impact --via-graph` auto-writes `last.json` (with
`--no-persist` opt-out). `shrk impact baseline write` mirrors the
arch baseline pattern.

- `code-intelligence-impact`
  - `Warning` on `risk = high|critical` (listing direct + transitive
    counts, packages, recommended tests, public-API touch). Stale
    high-risk runs downgrade to advisory.
  - `Ok` on `low|medium`.

- `code-intelligence-impact-baseline`
  - `Ok` when last is within baseline along every axis.
  - `Warning` when dependents OR packages OR risk worsened. Fix:
    `shrk impact baseline show` for the delta; re-freeze when the
    growth is intentional.

### `code-intelligence-framework`

**Source:** `.sharkcraft/framework/meta.json` (schema
`sharkcraft.framework/v1`).

Surfaces per-framework entity counts (`nestjs=12, react=47, …`) from
the framework-scanner pipeline.

- `Ok` on fresh with a non-zero breakdown.
- `Info` + `advisory` when the scan found zero entities (often a
  misconfigured extractor).
- `Warning` + `advisory` when stale; `Warning` on corrupt JSON.

### `code-intelligence-structural-search`

**Source:** `.sharkcraft/structural/patterns.json` (schema
`sharkcraft.structural-pattern-registry/v1`).

The pattern registry holds reusable structural-search patterns
authored via `shrk search-structural registry add` or shipped by
packs.

- `Ok` when every entry has a fresh `lastValidatedAt`.
- `Warning` (not advisory) when any entry has `lastValidationError`.
  Invalid entries match nothing at runtime — the agent silently
  misses cases. Fix: `shrk search-structural registry validate`
  then re-`add` each failing pattern.
- `Info` + `advisory` for empty registry or unvalidated entries.

### `code-intelligence-context-planner`

**Source:** `.sharkcraft/context-planner/intent-benchmark.json`
(schema `sharkcraft.intent-benchmark/v1`).

Tracks the keyword-based intent classifier's accuracy against the
author-checked-in fixture at `sharkcraft/intent-benchmark.json`. The
classifier drives the ranker's weights — wrong intent → wrong files
surfaced first → wasted agent turns.

- `Ok` at 100% accuracy.
- `Warning` + `advisory` at ≥ 80% (calibration drift but ranker
  is mostly fine).
- `Warning` (not advisory) below 80% — ranker is materially
  miscalibrated.
- Fix: `shrk context benchmark` re-runs the fixture; add a keyword
  to `classifyIntent` if the regression is real.

### `code-intelligence-schema-mismatch`

**Source:** every stored code-intelligence payload (cross-store).

Walks each store, reads the top-level `schema` field, compares to
inspector's `EXPECTED_SCHEMAS` table. Single `Warning` aggregates
all mismatches with a regenerate hint per affected store.

A mismatch means the loader returns undefined (silently — to stay
forward-compatible), which downstream surfaces show as "no data".
The doctor surface makes that visible.

## Doctor flags that affect this category

```
shrk doctor --hide code-intelligence       # mute the section
shrk doctor --explain-quality              # show "why this matters"
shrk doctor --json                         # machine output (always includes the section)
shrk doctor --focus warnings-new           # show only new vs baseline
shrk doctor --strict=warnings              # fail on non-advisory warnings
shrk doctor --strict=all                   # fail on advisory warnings too
```

## Schema versions referenced

| Package | Schema |
|---|---|
| `@shrkcrft/graph` | `sharkcraft.graph/v1` |
| `@shrkcrft/rule-graph` | `sharkcraft.rule-graph/v1` |
| `@shrkcrft/api-surface-diff` | `sharkcraft.api-surface-cache/v1` |
| `@shrkcrft/quality-gates` | `sharkcraft.quality-gate-report/v1` |
| `@shrkcrft/migrate` | `sharkcraft.migration-run/v1` |
| `@shrkcrft/architecture-guard` | `sharkcraft.architecture-snapshot/v1` |
| `@shrkcrft/impact-engine` | `sharkcraft.impact-run/v1` |
| `@shrkcrft/framework-scanners` | `sharkcraft.framework/v1` |
| `@shrkcrft/structural-search` | `sharkcraft.structural-pattern-registry/v1` |
| `@shrkcrft/context-planner` | `sharkcraft.intent-benchmark/v1` |

If a stored file uses a schema not in the inspector's
`EXPECTED_SCHEMAS` table, the `code-intelligence-schema-mismatch`
check fires.

## See also

- `docs/code-intelligence.md` — design contract for the foundation
  (`@shrkcrft/graph`).
- `docs/code-intelligence-quick-ref.md` — agent-oriented cheat sheet.
- `docs/roadmap-code-intelligence.md` §5.5 — doctor integration
  status table.
