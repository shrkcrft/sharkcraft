# SharkCraft as a generic extension platform (R32)

SharkCraft's engine is project-agnostic. Project-specific knowledge,
paths, rules, templates, lifecycle profiles, agent tests, and search
tuning live in **packs** or local `sharkcraft/` configuration — never in
the engine packages under `packages/`.

## What the engine ships

- Generic data models (knowledge, rules, paths, templates, pipelines,
  presets, boundaries, constructs, scaffold patterns, playbooks,
  policies).
- Generic loaders for each contribution kind.
- Generic CLI commands (read-only inspectors + plan-only generators).
- Generic MCP tools (read-only).
- Generic profile registries (R32):
  - `IPluginLifecycleProfile`
  - `IMigrationProfile`
  - Future: command, generator, boundary, naming, architecture, language,
    report profiles.
- A migration helper (`shrk migrate project-coupling …`) so users can
  externalise their own project-specific behavior.

## What the engine does NOT ship

- Hardcoded paths (`libs/<project>/…`).
- Hardcoded plugin layouts, key tables, or barrels.
- Project-named identifiers in core code (e.g. `'<project>'`, `FEATURE_KEYS`).
- Project-specific contract templates, migration profiles, playbook ids.

## Where project-specific behavior lives

| Concern | Location |
|---|---|
| Plugin lifecycle layout | pack `pluginLifecycleProfileFiles[]` |
| Knowledge entries | pack `knowledgeFiles[]` |
| Rules | pack `ruleFiles[]` |
| Path conventions | pack `pathConventionFiles[]` / `pathFiles[]` |
| Templates | pack `templateFiles[]` |
| Pipelines | pack `pipelineFiles[]` |
| Constructs | pack `constructFiles[]` |
| Playbooks | pack `playbookFiles[]` |
| Search tuning | pack `searchTuningFiles[]` |
| Feedback rules | pack `feedbackRuleFiles[]` |
| Decisions | pack `decisionFiles[]` |
| Contract templates | pack `contractTemplateFiles[]` |
| Migration profiles | pack `migrationProfileFiles[]` |
| Conventions | pack `conventionFiles[]` (reserved for R32+) |

## How to migrate a fork that bakes project knowledge into the engine

```bash
shrk migrate project-coupling audit --token <project> --token packages/<project> --token FEATURE_KEYS
shrk migrate project-coupling plan  --token <project> --token packages/<project> --token FEATURE_KEYS
shrk migrate project-coupling report --token <project> --token packages/<project> --token FEATURE_KEYS
```

For each high-risk hit the helper suggests an externalisation target:
pack contribution, local config, profile, fixture-only, or docs-example.

## See also

- `docs/plugin-lifecycle-profiles.md` — the lifecycle profile API.
- `docs/profiles.md` — the generic profile registry surface.
- `docs/pack-contributions.md` — all pack contribution slots.
- `docs/project-specific-knowledge.md` — the explicit rule.
- `docs/safety-model.md` — MCP read-only invariant, plan signing, etc.
