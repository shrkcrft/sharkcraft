# Template profile metadata

Templates can declare optional `metadata` fields used by
`shrk templates drift`, `shrk coverage scaffolds`, `shrk context`,
and `prepare_agent_task` — never by the renderer itself.

## Fields

- `forbiddenPathFragments?: readonly string[]` — paths the rendered
  template must not produce.
- `requiredProfileIds?: readonly string[]` — WorkspaceProfile ids the
  template depends on (`has-typescript`, `is-library`, … — `shrk profiles
  list --kind workspace`). The self-config doctor resolves them against the
  builtin `workspace-profile` kind (round 12; they used to be checked against
  migration profiles).
- `requiredConventionIds?: readonly string[]` — convention ids the
  template's outputs are expected to satisfy.
- `requiredHelperIds?: readonly string[]` — helper ids that complete
  the workflow around this template.
- `requiredLanguages?: readonly string[]` — language profiles the
  template assumes (e.g. `typescript`, `java`).
- `requiredFrameworks?: readonly string[]` — framework profiles the
  template assumes (e.g. `angular`, `react`).

These fields are informational. The engine never embeds project-
specific values into the metadata reader; values flow from pack
contributions.
