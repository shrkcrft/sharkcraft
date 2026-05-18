# Universal check-result protocol

`sharkcraft.check-result/v1` — the schema any tool can emit so
SharkCraft can aggregate results from itself + ESLint + Biome +
custom project checks into one rollup.

## Why a universal protocol

R43 introduced `sharkcraft.custom-check/v1` for descriptor-driven
checks attached to rules: one descriptor, one report, one run. That
shape works for the rule-attached lifecycle but does not aggregate
across tools.

R47 adds a separate, deliberately small protocol for aggregation.
The two schemas coexist; pick the one that fits the use case.

| Schema | Use case |
|---|---|
| `sharkcraft.custom-check/v1` (R43) | A rule says "run this script and read this report shape" |
| `sharkcraft.check-result/v1` (R47) | Any tool emits its findings in a SharkCraft-ingestible JSON |
| `sharkcraft.check-aggregate/v1` (R47) | Rollup of several v1 results into one summary |

## v1 shape

```ts
interface CheckResult {
  schema: 'sharkcraft.check-result/v1';
  tool: string;                // 'eslint' | 'biome' | 'tsc' | 'jest' | <your-tool>
  command?: string;            // canonical command that produced this report
  generatedAt: string;         // ISO timestamp
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  findings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    total: number;
  };
  metadata?: Record<string, unknown>;   // free-form; for round-tripping tool-specific data
  sourceReportPath?: string;            // where the raw report came from
}

interface Finding {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  column?: number;
  ruleId?: string;
  message: string;
  suggestedAction?: string;
  safeToAutoFix?: boolean;
  metadata?: Record<string, unknown>;
}
```

## Aggregate shape

```ts
interface CheckAggregate {
  schema: 'sharkcraft.check-aggregate/v1';
  generatedAt: string;
  overall: 'pass' | 'warn' | 'fail' | 'unknown';   // worst wins
  total: { errors: number; warnings: number; infos: number; total: number };
  entries: { tool: string; status: CheckResult['status']; summary: CheckResult['summary']; sourceReportPath: string }[];
  findings: Finding[];   // rolled up across every entry
}
```

`overall` precedence: `fail` > `warn` > `pass` > `unknown`. An empty
aggregate is `unknown` — important so CI does not green-check when
there is nothing to check.

## CLI surface

```bash
# Import any v1 file (auto-detects format heuristically; --as forces).
shrk checks import <file> [--as eslint|biome|v1] [--tool <name>]

# Roll up everything in .sharkcraft/checks/ into one report.
shrk checks aggregate [--no-write] [--output <path>] [--json]

# Render the rollup (or each individual result) as text/markdown/json.
shrk checks report [--format text|markdown|json] [--output <path>]

# One-shot convert a third-party file into v1 JSON.
shrk checks convert eslint <file> [--output <path>] [--store]
shrk checks convert biome <file> [--output <path>] [--store]
```

Imported reports are stored under `.sharkcraft/checks/<ts>-<slug>.json`.
This is the **only** write surface; no other R47 command writes there.

## Round-trip examples

### ESLint → v1

```bash
npx eslint --format json . > eslint.json
shrk checks convert eslint eslint.json --output checks/eslint-v1.json
# checks/eslint-v1.json is sharkcraft.check-result/v1
```

### v1 → markdown

```bash
shrk checks aggregate          # writes .sharkcraft/checks/aggregate.json
shrk checks report --format markdown > pr-comment.md
```

### CI flow with both ESLint and SharkCraft boundaries

```yaml
- run: bun run shrk check boundaries --json > boundaries.json
- run: bun run shrk eslint report --from boundaries.json > sharkcraft-as-eslint.json
- run: npx eslint --format json . > native-eslint.json
- run: bun run shrk checks import sharkcraft-as-eslint.json --as eslint
- run: bun run shrk checks import native-eslint.json --as eslint
- run: bun run shrk checks aggregate
- run: bun run shrk checks report --format markdown > pr-summary.md
```

Both the native ESLint findings and SharkCraft boundary violations
land in the same v1 rollup. `overall` reflects the worst across all
inputs.

## Conversion guarantees

The R47 converters are **not lossy** but are **shape-only**:

- ESLint: `ruleId / severity / message / line / column / file` survive
  natively. `endLine` / `endColumn` / `fix.range / fix.text` are
  preserved under `metadata` on each finding so a round-trip back to
  ESLint shape is possible (today only one-way: ESLint → v1).
- Biome: SharkCraft's adjacent shape (R47 `biome report`) round-trips
  cleanly. The Biome converter also handles `{ diagnostics: [...] }`
  emitted by Biome's `--reporter json`, but **Biome's JSON contract
  is not stable** — we accept best-effort and document this in
  `docs/biome-bridge.md`.
- JUnit XML conversion is **not** in R47 (was listed as "if easy" in
  the brief; deferred — XML parsing pulled into the engine for one
  fixture-style use case is over-budget).

## What this protocol is **not**

- Not a write surface beyond `.sharkcraft/checks/`. The CLI never
  executes a third-party tool on import.
- Not a replacement for `shrk doctor`. Doctor remains the SharkCraft
  health gate.
- Not a replacement for `shrk safety audit`. Safety audit reads the
  whole config tree and answers a different question.
- Not exposed via MCP write. MCP stays read-only. R47 added no MCP
  tools.

## Schema constants (for tool authors)

```ts
import {
  CHECK_RESULT_SCHEMA,        // 'sharkcraft.check-result/v1'
  CHECK_AGGREGATE_SCHEMA,     // 'sharkcraft.check-aggregate/v1'
  CheckResultStatus,
  CheckFindingSeverity,
  parseCheckResult,
  parseCheckResultFromFile,
  buildCheckResult,
  buildCheckAggregate,
  convertEslintToCheckResult,
  convertBiomeToCheckResult,
} from '@shrkcrft/inspector';
```

These are the canonical entry points. The CLI commands are thin
wrappers — anything you can do on the command line you can do in TS
by importing from `@shrkcrft/inspector`.
