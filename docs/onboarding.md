# Onboarding existing repositories

`shrk onboard` analyzes an existing repository and produces a SharkCraft
onboarding plan: detected profiles, recommended presets, inferred path
conventions / rules / templates / boundary rules / pipelines, verification
commands lifted from `package.json`, a readiness before/after estimate, and a
list of next commands.

Default is **dry-run** — nothing is written. Pass `--write-drafts` to
materialize advisory drafts under `sharkcraft/onboarding/`.

```bash
shrk onboard                                          # dry-run (default)
shrk onboard --dry-run                                # explicit
shrk onboard --write-drafts                           # write advisory drafts
shrk onboard --write-drafts --scaffold-templates      # also draft runnable bodies
shrk onboard --write-drafts --import-agents           # also import AGENTS.md / CLAUDE.md / .cursor/rules
shrk onboard --diff                                   # compare inferred vs. live config (no writes)
shrk onboard --preset bun-service
shrk onboard --json
```

## Output

Drafts only ever live in:

```
sharkcraft/onboarding/
  onboarding-report.md
  inferred-rules.draft.ts
  inferred-paths.draft.ts
  inferred-templates.draft.ts        # body + variables when --scaffold-templates
  inferred-boundaries.draft.ts
  inferred-pipelines.draft.ts
  imported-agent-rules.draft.ts      # only when --import-agents finds entries
```

SharkCraft **never** overwrites `sharkcraft/rules.ts`, `sharkcraft/paths.ts`,
or `sharkcraft/templates.ts`. Adopting a draft is always a manual step — copy
the entries you like, ignore the ones you don't.

## What `shrk onboard` infers

See [inference.md](./inference.md) for the full inference rules. A summary:

| Asset | Source |
|---|---|
| Path conventions | Detected folders (`src/`, `src/services`, `libs/`, `apps/`, `tests/`, …) |
| Verification commands | `package.json scripts.{test,typecheck,lint,build,affected:*}` |
| Boundary rules | Layer-style folder names (`core / common / runtime / kernel / plugin / adapter / ui`) — only when 3+ detected |
| Template candidates | File-name patterns (`*.service.ts`, `*.util.ts`, `*.component.tsx`, `*.spec.ts`) |
| Rules | Package manager, TS strict, test runner, monorepo layout, ESLint, existing AGENTS.md/CLAUDE.md/.cursor/rules |
| Pipelines | Profiles + scripts (`unit-test`, `safe-generation`, `feature-dev`, `release-check`, `pr-review`) |

## Readiness estimate

The plan reports a current and expected AI-readiness grade. The current grade
comes from `shrk ai-readiness`. The expected grade is a conservative bump
based on the size of the inferred plan — capped at +20 points so we don't
over-promise.

```
readiness   poor (12) → poor (31)
```

Grades: `poor / partial / good / excellent`.

## Existing instruction files

If your repo already has `AGENTS.md`, `CLAUDE.md`, or `.cursor/rules`, the
onboarding plan calls them out and prints the corresponding `shrk import …`
command. They are **never** auto-imported into `sharkcraft/rules.ts`.

Pass `--import-agents` to parse them into a single bundle and write a
`sharkcraft/onboarding/imported-agent-rules.draft.ts` file alongside the other
drafts. Ambiguous bullets are flagged in a comment so you can rewrite them
before adopting. As with every other draft, you copy keepers into `rules.ts`
by hand.

## Template scaffolding (`--scaffold-templates`)

By default, template candidates are surfaced as **metadata** — the user is
expected to author the body. With `--scaffold-templates`, high- and
medium-confidence service / utility / test / component candidates also get a
runnable body inferred from a representative sample:

- class names are replaced with `<className>`
- top-level function / component identifiers are replaced with `<fnName>` /
  `<componentName>`
- the file's kebab base name is replaced with `<name>` everywhere it appears
- a `targetPath` pattern is suggested
- a `variables` array is emitted with sensible defaults from the sample

Safety rails: large files (>20 KB / >200 lines) are skipped, files with too
many string literals are skipped, complex/relative imports trigger warnings
instead of clobbering, and **low-confidence single-sample candidates are
never scaffolded**. The draft never replaces `sharkcraft/templates.ts`.

## Onboard diff (`--diff`)

`shrk onboard --diff` compares the inferred plan against the live SharkCraft
configuration and prints a Markdown table. It is **purely advisory** — nothing
is merged. Each entry is one of:

- `already-covered` — the live config already has it
- `missing` — the plan wants it, the live config doesn't have it
- `low-confidence-only` — too thin to promote; review manually
- `conflicting` — currently unused (reserved for future schema drift)

Use it after `--write-drafts` to decide which drafts are worth adopting.

## Monorepo onboarding

When SharkCraft detects an Nx workspace, a `package.json` workspaces array,
or `apps/` + `packages/` + `libs/` layout, the plan also includes a
`monorepoSummary`:

- detected apps / packages / libs (with their `package.json` name + scripts)
- root-level verification commands
- per-package verification hints using the right runner (`bun --cwd …`,
  `pnpm --filter`, `yarn workspace`, `npm run … --workspace`)
- boundary candidates derived from the layout (e.g. `packages/** must not
  import from apps/**`)
- preset recommendations for the monorepo root

The fixture in `examples/unconfigured-monorepo/` is the dogfood target.

## MCP

The read-only MCP tools mirror the CLI:

- `create_onboarding_plan` → returns the structured plan + `nextCommands`. Accepts:
  - `preferredPreset?`
  - `scaffoldTemplates?` — preview runnable scaffolds
  - `importAgents?` — preview imported agent rules
  - `includeDiff?` — preview the diff vs. the live config
- `get_onboarding_report_preview` → returns the rendered Markdown report.
- `list_inferred_assets` → returns the asset ids only.

None of them write files. Drafts are always a CLI action.

## Honest limitations

- No AI, no embeddings — the engine is purely deterministic.
- Template detection is conservative: low-confidence candidates are surfaced
  as risks instead of full drafts.
- Boundary inference fires only when at least 3 known layer names appear in
  the workspace; otherwise we keep quiet.
- Verification commands are taken at face value from `package.json` — the
  engine does not run them.
