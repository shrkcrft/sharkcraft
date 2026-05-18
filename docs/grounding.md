# `shrk grounding` and `shrk plan check`

R58 added two read-only verbs that let external SDD plugins / skills
ground their work against the live workspace without adopting any
shrk-specific format.

> **The contract:** if you uninstall shrk tomorrow, your repository
> is bit-identical to what it was before. shrk's value is purely
> *additive* — grounding + validation — and nothing about your specs,
> plans, or docs format depends on it.

## `shrk grounding "<task>"` — context primer

Single-call output for plugin / skill consumption.

```bash
shrk grounding "wire billing endpoint" --json
```

Returns a `sharkcraft.grounding/v1` payload:

```jsonc
{
  "schema": "sharkcraft.grounding/v1",
  "task": "wire billing endpoint",
  "generatedAt": "2026-05-17T01:25:15.178Z",
  "rules": [
    { "id": "repo.architecture.respect-layer-order", "title": "...", "priority": "critical" }
  ],
  "knowledge": [
    { "id": "engine.docs", "title": "Authoritative documentation", "scope": ["docs"] }
  ],
  "paths": [{ "id": "engine.packages", "title": "Engine packages" }],
  "templates": [{ "id": "engine.cli-command", "name": "CLI command", "appliesWhen": [...] }],
  "verificationCommandIds": ["typecheck", "unit-tests"],
  "recommendedMcpTools": ["inspect_workspace", "get_relevant_context", ...],
  "recommendedCliCommands": ["shrk check boundaries", ...],
  "tokenEstimate": 1240
}
```

Read-only. Composes existing primitives (`buildTaskPacket` +
`searchKnowledge`). No LLM, no shell-out. Deterministic for fixed
inputs.

### Skill / plugin usage

The recommended integration: have your SDD skill call
`mcp__sharkcraft__get_grounding({ task })` early in its planning
phase, then weave the returned rules / knowledge / templates into
its prompt. shrk owns the grounding data; your skill keeps owning
the plan format.

## `shrk plan check <path>` — validate external plans

Validate a plan file the team already wrote — in any markdown shape
— against the live workspace.

```bash
# Auto-pick the extractor based on filename.
shrk plan check plans/feature.md --json

# Use loose-frontmatter mode explicitly.
shrk plan check plans/feature.md --extractor markdown-frontmatter-loose --json

# Remap team-specific frontmatter keys to canonical fields.
shrk plan check plans/feature.md \
  --extractor markdown-frontmatter-loose \
  --field-map '{"files_changed":"affectedFiles","verify_with":"verificationCommandIds"}'
```

Returns a `sharkcraft.plan-check/v1` payload:

```jsonc
{
  "schema": "sharkcraft.plan-check/v1",
  "source": "plans/feature.md",
  "extractorId": "markdown-frontmatter-loose",
  "verdict": "fail",                  // pass | warn | fail
  "errors": [
    { "code": "unknown-rule-id", "field": "relevantRules[1]", "message": "..." }
  ],
  "warnings": [],
  "nx": {                              // present only when nx.json detected
    "enabled": true,
    "affectedProjects": ["acme-api", "acme-lambda"]
  }
}
```

The input file is NEVER modified.

### Two built-in extractors

| ID | Accepts | Notes |
| --- | --- | --- |
| `sharkcraft.spec/v1` | `*spec.md` | Wraps the R57 parser. Highest-fidelity path. |
| `markdown-frontmatter-loose` | `*.md`, `*.mdx` | Any YAML frontmatter. Use `--field-map` to remap team-specific keys to canonical ones. |

### Canonical field keys

The `--field-map` flag is `{ "externalKey": "canonicalKey" }`.
Recognised canonical keys:

- `intent`, `motivation`, `title`
- `affectedFiles`, `affectedPackages`
- `affectedAreas.files`, `affectedAreas.packages` (aliases)
- `acceptanceCriteria`
- `relevantRules`, `relevantKnowledge`, `relevantPaths`
- `proposedTemplates`
- `verificationCommandIds`

Unknown canonical keys are silently ignored. The team's plan file
can carry any number of additional fields — they pass through into
`raw` for traceability and do nothing else.

### Nx awareness

When `nx.json` is present, `shrk plan check`:

1. Walks `apps/`, `libs/`, `packages/` for `project.json` files (no
   shell-out to the `nx` CLI — pure fs).
2. Maps the plan's declared `affectedFiles` to project names via
   longest-prefix match on `project.json` `root`.
3. Reports the unique project list under `nx.affectedProjects`.

When `nx.json` is absent, the `nx` block is omitted from the
response — no failure.

## MCP read-only siblings

| MCP tool | CLI sibling |
| --- | --- |
| `mcp__sharkcraft__get_grounding` | `shrk grounding` |
| `mcp__sharkcraft__check_external_plan` | `shrk plan check` |

Both are read-only. NO write tools were added for grounding or plan
checking (matching the R44 safety contract: MCP never writes).

`check_external_plan` accepts either a `path` (resolved against the
project root) or inline `content` (string) — handy for skills that
have the plan in memory.

## The additive principle, enforced

R58 ships a contract test (`r58-additive-contract.test.ts`) that:

1. Sets up a synthetic repo with team docs + a non-shrk-shaped plan.
2. Snapshots every tracked file outside `.sharkcraft/`.
3. Runs `shrk grounding` and `shrk plan check`.
4. Re-snapshots.
5. Asserts every tracked file is byte-identical.

If anyone ever adds a feature that writes outside `.sharkcraft/`,
this test will catch it.
