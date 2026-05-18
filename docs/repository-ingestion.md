# Repository ingestion

The `shrk ingest` command group deeply ingests a repository into a SharkCraft
repository knowledge model. The goal is **not** to summarise the repo — it is
to **model** it deterministically so a fresh AI agent can pick the work up
cold and a human can review what would land in `sharkcraft/*.ts`.

## Quickstart

```bash
shrk ingest repository                            # dry-run; print the model
shrk ingest repository --write-drafts             # write drafts under sharkcraft/ingestion/
shrk ingest repository --adopt                    # write adoption patch under sharkcraft/ingestion/adoption/
shrk ingest report --format markdown              # render the saved model as markdown
shrk ingest status                                # what exists on disk
shrk ingest diff --format markdown                # what would change vs live sharkcraft/*.ts
shrk ingest adopt --write-patch                   # produce a reviewable adoption patch
shrk ingest clean --write                         # delete sharkcraft/ingestion/ (default is --dry-run)
```

## What gets produced

`shrk ingest repository --write-drafts` writes under `sharkcraft/ingestion/`:

- `repository-knowledge-model.json` — the full structured model.
- `REPOSITORY_KNOWLEDGE_MODEL.md` — combined markdown summary.
- One markdown file per section: `REPO_OVERVIEW.md`, `ARCHITECTURE_MODEL.md`,
  `BUSINESS_LOGIC_MODEL.md`, `RULES_AND_CONVENTIONS.md`,
  `DEPENDENCY_BOUNDARIES.md`, `DOMAIN_MAP.md`, `WORKFLOW_MAP.md`,
  `CHANGE_PROTOCOL.md`, `RISK_AREAS.md`, `CONTRADICTIONS.md`,
  `OPEN_QUESTIONS.md`, `GENERATED_VS_HANDWRITTEN.md`, `STABILITY.md`,
  `TASK_CONTEXT_HINTS.md`.
- Ten draft TypeScript files under `generated/`:
  `knowledge.draft.ts`, `rules.draft.ts`, `paths.draft.ts`,
  `boundaries.draft.ts`, `constructs.draft.ts`, `policies.draft.ts`,
  `playbooks.draft.ts`, `templates.draft.ts`, `pipelines.draft.ts`,
  `presets.draft.ts`.

Each draft entry includes a "why this goes here" provenance string.

`shrk ingest adopt --write-patch` additionally writes under
`sharkcraft/ingestion/adoption/`:

- `ingest-adoption-state.json`
- `ingest-adopt.patch` (review-only Markdown patch)
- `ingest-adopt-summary.json`
- `ingest-adoption-plan.md`

Entries are bucketed as `safe-append` / `manual-review` / `low-confidence` /
`already-covered` / `generated-protected`.

## Sections

The repository knowledge model has 15 sections. Each one can be
included/excluded with `--include <section>` / `--exclude <section>`:

| Section | Source signals |
|---|---|
| `repositoryOverview` | workspace inspector |
| `architectureModel` | area map + import graph + public-API barrels |
| `businessLogicModel` | construct registry + framework heuristics |
| `rulesAndConventions` | inferred rules + path conventions + verification commands |
| `dependencyBoundaries` | inferred boundary rules + import-graph summary |
| `domainMap` | area map + constructs |
| `workflowMap` | package scripts + inferred pipelines |
| `changeProtocol` | rules of thumb (feature / refactor / public-API / Angular) |
| `riskAreas` | high-fan-in + deprecated stability hits |
| `contradictions` | doc vs code findings |
| `openQuestions` | low-confidence signals |
| `generatedVsHandwritten` | generated-code classifier |
| `stableExperimentalDeprecated` | stability map |
| `taskContextHints` | per-trigger hints (Angular / TS / generated / deprecated / contradictions) |
| `recommendedSharkCraftFiles` | what should land in each `sharkcraft/*.ts` |

## Presets and transformational intent

- `--preset modern-angular --preset strict-typescript` forces those presets
  even if the workspace profiles do not match.
- If a forced preset's `appliesTo` does not overlap with the workspace's
  detected profiles, it is recorded as **transformational intent** rather
  than discarded: the ingest output reads as adaptation guidance for moving
  the repo *toward* that preset.

## Depth

- `--depth shallow` skips the import graph.
- `--depth standard` (default) — full inspection minus expensive heuristics.
- `--depth deep` / `--extreme` — currently behave like standard but reserved
  for future expansions (e.g. richer fan-in / stability analysis).

## Safety

- Dry-run by default. No writes occur without `--write-drafts` or `--adopt`.
- `--write-drafts` writes ONLY under `sharkcraft/ingestion/`. The function
  refuses paths that escape the configured `outDir`.
- `--adopt` writes ONLY under `sharkcraft/ingestion/adoption/`. Live
  `sharkcraft/*.ts` is never overwritten by `shrk ingest`.
- MCP exposes the model as read-only via `create_repository_ingestion_plan`,
  `get_repository_knowledge_model`, `get_repository_ingestion_status`,
  `get_repository_ingestion_report`, `get_ingest_adoption_preview`. None of
  them write.
