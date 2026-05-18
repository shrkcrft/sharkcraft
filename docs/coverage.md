# Coverage report

`shrk coverage` measures **relationship quality** in your SharkCraft
configuration. Distinct from AI-readiness (which scores depth and
quantity), coverage scores whether things link to each other in a way
that lets an agent traverse the project intelligence.

Categories scored 0–100:

| Category | What |
|---|---|
| Templates have descriptions | description ≥ 5 chars |
| Templates declare related rules/paths | `template.related[]` non-empty |
| Critical/high entries carry actionHints | every must-follow rule has hints |
| Pipelines reference resolvable templates/rules | step.references resolve |
| Presets compose + reference assets that resolve | resolvePresetReferences clean |
| Boundary rules ship a `suggestedFix` | non-empty string |
| Packs ship at least one doc | `docsFiles[]` non-empty |

```bash
shrk coverage
shrk coverage --json
```

MCP: `get_coverage_report`.
