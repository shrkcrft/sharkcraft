# Repository knowledge model

`IRepositoryKnowledgeModel` is the canonical structured model SharkCraft
produces for an ingested repository. Schema:
`sharkcraft.repository-knowledge-model/v1`. Module:
`packages/inspector/src/repository-knowledge-model.ts`.

## Inputs

- `inspection` — the `ISharkcraftInspection` from
  `inspectSharkcraft({ cwd })`.
- `depth` — `shallow` / `standard` / `deep` / `extreme`.
- `selectedSections` / `excludedSections` — opt sections in or out.
- `forcedPresetIds` — pin one or more presets.
- `task` — optional free-form description to bias context hints.

## Outputs

The model carries all 15 ingestion sections plus:

- `presets` — full `IPresetRecommendation[]` (with `confidence` + `score` +
  `reasons`).
- `forcedPresetIds` — what the caller pinned.
- `transformationalIntents` — entries created when a forced preset does not
  match the workspace profiles. Treat as adaptation guidance.
- `confidence` — overall 0–100 number plus per-section breakdown plus notes.
- `limitations` — what was sampled or skipped.
- `inferredPipelines` / `inferredTemplates` — straight from the onboarding
  plan for downstream tooling.

## Determinism

The model is a pure function of the workspace and the asset registries. No
network, no LLM, no fan-out beyond `findFiles` and existing inspector
helpers. Re-running ingest with the same workspace state produces the same
output.

## Composition

The builder composes existing inspector modules:

- `buildOnboardingPlan` for rules/paths/templates/boundaries/pipelines.
- `buildAreaMap` for areas.
- `analyzeImportGraph` for fan-in (when depth ≥ standard).
- `buildGeneratedCodeReport` for generated/handwritten.
- `buildContradictionReport` for docs-vs-code findings.
- `buildStabilityMap` for stability classification.
- `listConstructs` / `loadConstructs` for business logic candidates.

## Renderers

- `renderRepositoryKnowledgeModelText`
- `renderRepositoryKnowledgeModelMarkdown`
- `renderRepositoryKnowledgeModelHtml`
- `renderRepositoryKnowledgeModelJson`
