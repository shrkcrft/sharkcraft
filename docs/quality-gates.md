# Quality gates

`shrk quality` is the one-command local gate before opening a PR. It
orchestrates the existing SharkCraft checks and aggregates them into a
single pass / warn / fail verdict.

```bash
shrk quality                    # text output
shrk quality --strict           # warnings become blockers
shrk quality --ci               # JSON output for CI
shrk quality --json
```

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

A non-zero exit means at least one **blocking** gate failed. Warnings
return zero unless `--strict` is set.

## Output shape

`quality --json` returns:

```jsonc
{
  "overall": "pass | warn | fail",
  "blockers": 0,
  "warnings": 1,
  "score": 88,
  "gates": [
    { "id": "doctor",     "label": "Project doctor",   "passed": true,  "blocking": true,  "notes": [] },
    { "id": "boundaries", "label": "Boundary check",   "passed": false, "blocking": false, "notes": [...] }
  ],
  "nextRecommendations": ["Run `shrk check boundaries` to inspect cross-layer imports."]
}
```
