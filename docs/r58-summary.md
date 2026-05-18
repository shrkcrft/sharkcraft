# R58 — Summary

R58 closes the remaining gaps from the post-R57 reassessment in
`feedback_new.md`. No new arcs were started; every part addresses an
item the user explicitly named as missing, partial, or wrong.

Audit lives at `.sharkcraft/reports/r58-feedback-gap-audit.md`.

---

## What shipped

### PART 1 — `shrk knowledge propose`

AST-driven inference of stub knowledge entries for exported top-level
constructs that lack coverage. Closes the authoring loop the user
flagged as the highest-value missing piece.

- Command: `shrk knowledge propose [--path <file>] [--symbol <name>] [--since <ref>|--all] [--json] [--write]`
- MCP sibling (read-only): `preview_knowledge_propose`
- Library: `proposeKnowledge()` in `@shrkcrft/inspector`
- Schema: `sharkcraft.knowledge-propose/v1`
- `--write` materialises drafts under `.sharkcraft/authoring/proposed/`
- Default scans git-changed files (`--since HEAD`); pass `--all` for the full workspace
- Coverage check uses existing `references[]` symbol + file refs

Tests: `packages/inspector/src/__tests__/propose-knowledge.test.ts`,
`packages/cli/src/__tests__/r58-knowledge-propose.test.ts`.

### PART 2 — Wide knowledge-stale rename detection

Reduces the cases where the only safe option is drop. Adds a multi-
candidate detector and a path-overlap scorer behind a new flag.

- New flag: `shrk fix --knowledge-stale --apply --rename-strategy strict|wide`
- Default stays `strict` (R54/R55 behaviour preserved)
- New types: `RenameStrategy`, `IReplacementCandidate`
- `replaceWith.candidates[]` carries the ranked list under wide mode
- Wide auto-applies only when one candidate clearly leads (score ≥ 0.66 and ≥ 0.20 ahead of #2)
- Entry-corroboration boost: when multiple stale refs in the same entry name the same candidate, that candidate's score is bumped

Tests: `packages/inspector/src/__tests__/r58-stale-rename-wide.test.ts`.

### PART 3 — `docs/schemas/` on-disk emission

The in-memory schema registry now mirrors to disk so agents can grep
`docs/` for schema ids.

- New verb: `shrk schemas emit [--out <dir>] [--write|--check] [--json]`
- Default: preview lists files that would change
- `--write`: persists `<name>.schema.json` for every schema + `INDEX.md`
- `--check`: exit non-zero on drift (wired into `release:preflight`)
- Schema: `sharkcraft.schemas-emit/v1`

Tests: `packages/cli/src/__tests__/r58-schemas-emit.test.ts`.

### PART 4 — Doctor-verb `--json` consistency

Every doctor-shaped verb now emits parseable JSON when `--json` is
set, including the error/validation paths.

- New audit script: `scripts/audit-doctor-json.ts` (also `bun run audit:doctor-json`)
- Wired into `release:preflight` (required step)
- Schema: `sharkcraft.doctor-json-audit/v1`
- `reposet doctor` now emits a JSON envelope on missing config (was text on stderr)

Tests: `packages/cli/src/__tests__/r58-doctor-json-audit.test.ts`.

### PART 5 — Round snapshots + `shrk diff rounds`

Round-to-round shipping diff verb. Answers "what shipped in R<n> vs
R<n-1>?" without scraping git logs.

- New commands:
  - `shrk rounds capture --id <id> [--title <text>] [--json]`
  - `shrk rounds list [--json]`
  - `shrk rounds show <id> [--json]`
  - `shrk diff rounds --from <id> --to <id> [--json]`
- Artifacts under `.sharkcraft/rounds/<id>/` (`snapshot.json` + `meta.json`)
- Schemas: `sharkcraft.round-snapshot/v1`, `sharkcraft.rounds-diff/v1`
- R58 is captured (see `.sharkcraft/rounds/R58/`)

Tests: `packages/cli/src/__tests__/r58-rounds.test.ts`.

### PART 6 — Surface profile auto-detection at init

`shrk init` now wires `surface.profile` into the generated
`sharkcraft.config.ts` instead of leaving every project on the empty
default. Doctor warns when configured and detected profiles diverge.

- New flag: `shrk init --surface-profile <id>` (override; validates against built-in list)
- Without override, init runs `suggestSurfaceProfile(workspaceProfiles)` and writes the result
- Generated config keeps a comment explaining which heuristic fired
- Doctor advisory `surface-profile-drift` fires when configured ≠ detected

Tests: `packages/cli/src/__tests__/r58-surface-profile-init.test.ts`.

---

## Catalog impact

| Round | Catalog entries | Default-visible | MCP tools |
|-------|-----------------|-----------------|-----------|
| R57   | 348             | 49              | 246       |
| R58   | 354 (+6)        | 49 (no change)  | 247 (+1)  |

All 5 R58 surface verbs added (`schemas emit`, `rounds capture / list / show`, `diff rounds`)
sit on `CommandSurface.Advanced` to keep the default agent view stable.
`knowledge propose` is the one R58 verb on `CommandSurface.Common` —
it's the only verb an agent reaches for during normal authoring work.

---

## Preflight changes

Two new gates in `scripts/release-preflight.ts`:

- `schemas-drift` — `shrk schemas emit --check` fails when `docs/schemas/` is stale.
- `doctor-json-audit` — `bun run audit:doctor-json` fails when any doctor verb regresses on `--json`.

Both are `required: true`.

---

## Deferred (out of scope for R58)

- **LSP / editor integration** — too large for one round; treat as a dedicated effort.
- **Catalog drift pruning pass** — revisit after R58 verbs have settled. Tracked for R59.

Coverage for these items is documented in `.sharkcraft/reports/r58-feedback-gap-audit.md` §A1, B3, C1.

---

## Validation

- `bun test`: 1727 / 1727 ✓
- `bun x tsc -p tsconfig.base.json --noEmit`: ✓
- `shrk doctor`: 6 OK, 0 errors
- `shrk schemas emit --check`: ✓ (docs/schemas/ matches registry)
- `bun run audit:doctor-json`: 8 / 8 doctor verbs emit JSON ✓
- `shrk diff rounds` against `R58-bootstrap` → `R58`: returns expected delta ✓
