# Quality gates

`shrk quality` is **the "before you push" command**: it runs every configured
gate — the inspector bundle *and* all seven [data-defined rule
planes](gate-rules.md) — to completion, and reports **every** failure with the
command that reproduces it in isolation.

```bash
shrk quality                    # exhaustive: every gate, every failure
shrk quality --changed-only     # scope the planes to the working diff
shrk quality --fail-fast        # stop at the first blocking failure (CI-like)
shrk quality --strict           # advisory failures become blockers
shrk quality --json             # the machine-readable run
```

## Why exhaustive is the default

A CI job that chains gates as separate steps stops at the **first** failing
step. When a tree has accumulated debt across several independent gates — the
classic case being a first-ever CI run on a long-lived branch — each failure
hides the next: fix gate A → push → wait → gate B appears → fix → push → wait →
gate C appears. Three already-present failures, discovered as three sequential
round-trips.

One local `quality` run surfaces all three. That only pays off if each failure
is immediately actionable, so every failing row carries its own repro line:

```
  FAIL   Coverage report
         ↳ hint-coverage at 47%
         $ shrk coverage
  FAIL   [baseline] transition-ceiling
         ↳ transition-ceiling — 3 is 1 above the limit of 2
         $ shrk gates explain transition-ceiling
```

`--fail-fast` opts into the opposite behaviour, and says so in the output rather
than letting the un-run gates look clean.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | every gate ran and passed |
| `1` | a blocking gate failed |
| `2` | nothing failed, but not everything was **measured** — a gate errored, or a rule's selector matched nothing. An unmeasured verdict is never a pass. |

A skip you **asked for** (`--changed-only` scope, `--fail-fast`) never forces
`2`; a skip nobody asked for always does. The global `--strict` promotes `2`
into `1` for a hard CI gate.

## Gates

| Gate           | Source                                |  blocking by default |
|----------------|---------------------------------------|----------------------|
| doctor         | `runDoctor(inspection)`               | yes                  |
| readiness      | `buildAiReadinessReport`              | if `minReadiness > 0` |
| boundaries     | `evaluateBoundaries` + `scanImports`  | no (configurable)    |
| coverage       | `buildCoverageReport`                 | only with `--strict` |
| drift          | `buildDriftReport`                    | only with `--require-drift-clean` or config |
| context-tests  | `loadContextTests` + `runContextTest` | only with `--strict` or config |
| agent-tests    | `loadAgentContractTests`              | only with `--strict` or config |
| packs          | `buildPackDoctorReport`               | only with `--strict` or config |
| every declared rule | the seven planes via `gates check` | per the rule's own `severity` |

The rule planes run through the **same** evaluator `shrk gates check` uses, so
the aggregate wired into pre-push can never disagree with the per-plane verb.

## Configuration

Add a `qualityGates` section to `sharkcraft/sharkcraft.config.ts` to make
gates blocking project-wide:

```ts
export default {
  // ...
  qualityGates: {
    minReadiness: 70,
    requireBoundaryClean: true,
    requireDriftClean: true,
    requireAgentTests: true,
    requireContextTests: true,
    requirePackSignatures: true,
  },
};
```

The corresponding CLI flags override the config: `--min-readiness`,
`--require-boundary-clean`, `--require-drift-clean`, `--require-agent-tests`,
`--require-context-tests`, `--require-pack-signatures`.

## The composite `shrk gate` — advisory impact & noise controls

`shrk gate` aggregates the code-intelligence gates (graph freshness,
architecture, impact, wiring, policy, …) into one pass/fail. Three refinements
keep it from going red on pre-existing structure:

- **Impact is advisory by default.** Blast-radius risk is a property of the
  existing structure, not a new failure, so a high/critical fanout **warns**
  instead of failing — a clean inline change clears the verdict. Opt back into a
  hard fail with `--fail-on critical` (or `--fail-on high`); `--strict`
  escalates the advisory warn to a blocker.
- **Type-only cycles are excluded.** The graph cycle detector now **ignores
  type-only import edges** (`import type`, `export type … from`) by default —
  they're erased at emit time and can't cause a runtime cycle. Type-only loops
  are reported in a separate non-blocking bucket; `shrk graph cycles
  --include-type-edges` opts them back into the cycle set.
- **`shrk policy-lint --new-only`.** Scans the whole tree but shows only the
  findings the change *introduced*, hiding pre-existing baseline debt (and
  reporting the hidden count) so a gate run isn't drowned in inherited noise.

## MCP

`get_quality_report` returns the same structured report over MCP. It is
strictly read-only — gates that would normally run a shell command are
skipped and the response includes a `nextCommand: "shrk quality --strict"`
hint so the human can run the full thing locally.

```jsonc
// input
{ "strict": true, "requireDriftClean": true }

// output (excerpt)
{
  "overall": "warn",
  "score": 88,
  "gates": [
    { "id": "drift", "label": "Drift report", "passed": false, "data": { "errors": 0, "warnings": 3 } }
  ],
  "drift": { "findings": [...], "counts": { "error": 0, "warning": 3, "info": 1 } },
  "note": "MCP cannot execute shell commands.",
  "nextCommand": "shrk quality --strict"
}
```

## CI usage

```yaml
- name: SharkCraft quality
  run: bun run shrk quality --ci > quality.json
- uses: actions/upload-artifact@v4
  with:
    name: sharkcraft-quality
    path: quality.json
```

## Output shape

`quality --json` (and `--ci`) returns the run, not a per-gate score:

```jsonc
{
  "schema": "sharkcraft.quality-run/v1",
  "passed": 12,
  "failed": 0,             // BLOCKING failures
  "failedWarnings": 2,     // advisory failures — `--strict` promotes these
  "skipped": 0,
  "errored": 0,            // gates that could not run: never counted as green
  "evaluated": 14,
  "verdict": "pass | fail | not-verified",
  "scopedFiles": 24,       // present only under --changed-only
  "failFast": false,
  "exitCode": 0,
  "items": [
    {
      "id": "coverage",
      "label": "Coverage report",
      "status": "passed | failed | skipped | error",
      "severity": "error | warning",
      "notes": ["hint-coverage at 47%"],
      "repro": "shrk coverage",
      "data": { "gaps": 1, "overall": 82 }
    },
    {
      "id": "baseline:transition-ceiling",
      "label": "[baseline] transition-ceiling",
      "status": "failed",
      "severity": "error",
      "notes": ["..."],
      "repro": "shrk gates explain transition-ceiling"
    }
  ],
  "diagnostics": []
}
```

`failed` and `failedWarnings` are reported separately on purpose: a summary
reading "0 failed" above a list containing FAIL rows is the kind of
self-contradiction that teaches people to stop trusting the summary.

A `skipped` item carries `skippedDeliberately: true` when the skip was
**requested** (scope narrowing, `--fail-fast`). Only an *accidental* skip pushes
the verdict to `not-verified`.

Each gate's structured payload — drift counts, boundary totals, a rule's
declared/registered sizes — rides on the item as `data`, rather than as
one-off top-level keys. A bundle that grows a `drift` key for the drift gate
cannot keep doing that as gates are added, and consumers would then have to know
which gates got a field and which did not.
