# Inference engine

The onboarding plan is built by a deterministic inference engine in
`@shrkcrft/inspector`. There is no AI, no embeddings, no network. Every
output is a function of `IWorkspaceSummary` + the filesystem.

## Template-body inference v2 (`shrk infer templates --ast`)

`shrk infer templates --ast` produces template draft candidates using the
TypeScript compiler API when it's installed, the bracket-balance
"lightweight" analyzer as a fallback, and the v1 regex scaffolder as a
last resort. Each candidate records its `provenance` (`ast` /
`lightweight` / `regex`) and a `confidenceReasons` list explaining the
verdict.

Extracted shape:

- exported class name (with decorators + public method signatures)
- exported function / arrow-function names
- React-style component names
- JSDoc on the primary class/function (best-effort)
- imports + classification (safe vs relative/aliased)

Safety filters:

- skip files larger than ~20KB or longer than 200 lines
- skip files with more than 12 string literals (too domain-specific)
- skip files with side-effectful top-level code
- never write to live `templates.ts` — only drafts under
  `sharkcraft/onboarding/`

Candidates are surfaced together with any **scaffold pattern** match
(see `docs/scaffold-patterns.md`): when an installed pack contributes a
pattern for the file's path, inference suggests the pattern's `templateId`
and uses the pattern's variable strategies. A copy-pasteable
`shrk gen <templateId> <name> --var …` command is included.

## Path conventions

For each known folder we ship a path-convention entry:

| Folder | Convention id | Content |
|---|---|---|
| `src/` | `paths.src` | Application source under src/ |
| `src/services/` | `paths.services` | Services follow `*.service.ts` |
| `src/utils/` | `paths.utils` | Pure utilities, one per file |
| `src/components/` | `paths.components` | One folder per component |
| `src/features/` | `paths.features` | Feature folders |
| `libs/` | `paths.libs` | Reusable libraries |
| `packages/` | `paths.packages` | Workspace packages |
| `apps/` | `paths.apps` | Deployable apps |
| `tests/` / `test/` / `__tests__/` | `paths.tests` | Test home |

Co-located tests (`*.spec.ts` under `src/`) also produce `paths.tests`.

## Verification commands

Read from `package.json scripts`. Mapped:

| Script name | Verification id |
|---|---|
| `test` | `test` |
| `typecheck` | `typecheck` |
| `lint` | `lint` |
| `build` | `build` |
| `test:mutation` | `mutation-tests` |
| `affected:test` | `affected-test` |
| `affected:lint` | `affected-lint` |

The command is rendered with the effective package manager
(`bun run / pnpm / yarn / npm run`). When no lockfile + no `packageManager`
field exists, we fall back to the `has-bun` profile signal, otherwise `npm`.

## Boundary rules

Boundary rules are not inferred. Author them explicitly in
`sharkcraft/boundaries.ts` once the repo's actual import directions
are known. The engine does not guess architecture shapes.

## Template candidates

Walk the project tree with depth 5 and match these patterns:

| Pattern | Template id | Confidence threshold |
|---|---|---|
| `*.service.ts` | `inferred.service` | high ≥ 3 files |
| `*.util.ts` | `inferred.util` | high ≥ 3 files |
| `*.component.tsx?` | `inferred.component` | high ≥ 3 files |
| `*.{spec,test}.tsx?` | `inferred.spec` | high ≥ 4 files |

Confidence drops to `medium` at 2+ files and `low` at 1 file. Low-confidence
candidates are surfaced but **also added to the risks list** so the user
reviews them.

### Template body scaffolding (`--scaffold-templates`)

With `--scaffold-templates`, the inference engine reads one representative
sample for each high/medium-confidence candidate and produces a runnable
body with placeholder variables:

- the class declaration's name is replaced with `<className>` (services)
- the top-level function / component name is replaced with `<fnName>` /
  `<componentName>` (utilities / components)
- the file's kebab base name is replaced with `<name>` everywhere it
  appears as a whole word

Guards (any of these skip scaffolding for a candidate, the metadata-only
entry is still emitted):

- sample > 20 KB or > 200 lines
- sample contains > 12 string literals (too domain-specific)
- candidate is low-confidence (single sample)

Complex / relative imports are kept as-is with a `warnings` array in the
scaffold so the user notices.

## Monorepo summary

Triggered when any of `is-monorepo`, `has-package-workspaces`, or `has-nx`
profiles are set. The summary contains:

- apps / packages / libs (up to 30 packages) with their detected scripts
- root verification commands (deduped) using the effective package manager
- per-package verification hints using the right invocation
  (`bun --cwd …`, `pnpm --filter`, `yarn workspace`, `npm run … --workspace`)
- boundary candidates derived from the layout
- preset recommendations for the monorepo root

The monorepo scan is intentionally bounded — we never recurse deeply into
any package.

## Rules

Sources (the `source` field):

- `package-json` — package manager, test runner, ESLint.
- `tsconfig` — strict mode on/off.
- `folder-structure` — monorepo layering.
- `agents-md` — existing AGENTS.md / CLAUDE.md / .cursor/rules detected.

## Pipelines

Emitted by profile + script combo:

- `unit-test` — when any test runner is present.
- `safe-generation` — when TypeScript is present.
- `feature-dev` — when `src/` and a test runner are present.
- `release-check` — when both `test` and `build` scripts exist.
- `pr-review` — when `.github/` is present.

## Readiness impact

The current grade is computed by `shrk ai-readiness`. The expected grade adds
a conservative bonus (cap = 20 points) based on the size of the inferred plan
and whether the repo lacks a sharkcraft config. We never claim more than one
grade jump per +15 points and the bonus is capped well below "excellent".

## Determinism

- Same workspace state → same plan, byte-for-byte.
- No clock, no random, no I/O outside the workspace root.
- File walks are bounded by `maxDepth: 5` and the standard ignore list
  (`node_modules`, `dist`, `.git`, …).
