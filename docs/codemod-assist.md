# Codemod-assist (NOT a codemod engine)

R43 added `shrk codemod` to help an agent plan cleanup work that a rule
exposes. The engine is honest about its scope:

- It can **inventory** affected files (when a check report or target
  list is supplied).
- It can **group by risk** using consumer counts from impact analysis.
- It can **suggest** an external tool (ts-morph / jscodeshift / eslint
  custom rule) for the actual rewrite.
- It can **emit a project-script template** under
  `.sharkcraft/fixes/`.

It cannot — and will never — rewrite source.

## CLI

```bash
shrk codemod plan --rule <ruleId>
shrk codemod plan --rule <ruleId> --from-report .sharkcraft/reports/check.json
shrk codemod inventory --rule <ruleId> --targets a.ts,b.ts
shrk codemod checklist --rule <ruleId> --from-report …
shrk codemod plan --rule <ruleId> --write-preview
```

`--write-preview` materialises:

- `.sharkcraft/fixes/codemod-<rule-id>.md` — the human-readable plan.
- `.sharkcraft/fixes/codemod-<rule-id>.template.ts` — a starter
  project-script that emits a `sharkcraft.custom-check/v1` report.

The engine never writes outside `.sharkcraft/fixes/`.

## Risk grouping

`shrk codemod plan` groups affected files by **consumer count**:

| Band | Consumers | Suggested first action |
| --- | --- | --- |
| `low` | 0 | safe to act on first |
| `medium` | 1–5 | act after a re-import sweep |
| `high` | >5 | schedule with owners |
| `unknown` | (no impact-analysis data) | run impact-analysis first |

Pass consumer counts via the `IMap<string, number>` parameter when
calling `buildCodemodAssistReport` directly, or use
`shrk impact analyze --files …` to get them.

## What the engine does NOT do

- It never edits source files.
- It never spawns external tools — the agent runs them after review.
- It never replaces ts-morph or jscodeshift.
- It does not add a write surface to MCP.

The brief calls these out explicitly because the failure mode SharkCraft
guards against is "engine pretends it can rewrite, deletes useful
re-exports, breaks downstream consumers". The codemod-assist surface
keeps the engine on the *governance* and *planning* side of the line;
the rewrite stays explicit and human-reviewed.

## Output structure

The full report (`shrk codemod plan --rule <id>` JSON) carries:

- `enginePromise[]` — the things the engine guarantees to do.
- `engineLimits[]` — the things it explicitly will NOT do.
- `affectedFiles[]` — `path`, `consumerCount`, `risk`, `suggestedAction`.
- `riskGroups` — `low | medium | high | unknown`.
- `recommendedExternalTool` — derived from rule tags (or use
  `--recommended-tool <text>` to override programmatically).
- `checklist[]` — actionable items per risk band + the rewrite step.
- `validationCommands[]` — what to run after the rewrite is done.
- `scriptTemplate` — `{ path, body }` for the starter project-script.

## See also

- `docs/custom-checks.md` — emit findings the engine can read.
- `docs/rule-authoring.md` — author the rule the codemod is for.
- `docs/safety-model.md` — why the engine never rewrites source.
