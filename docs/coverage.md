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
| Critical/high entries carry a **meaningful** actionHint | quality, not presence (see below) |
| Pipelines reference resolvable templates/rules | step.references resolve |
| Presets compose + reference assets that resolve | resolvePresetReferences clean |
| Boundary rules ship a `suggestedFix` | non-empty string |
| Packs ship at least one doc | `docsFiles[]` non-empty |

```bash
shrk coverage
shrk coverage --json
```

MCP: `get_coverage_report`.

## Hint coverage scores *quality*, not presence

The `hint-coverage` category does not reward a hint merely *existing* — an agent
under pressure to clear the gate could bolt a uniform `<command>` placeholder or
a lone `requiresHumanReview` onto every entry and go green without the guidance
improving. An entry counts as covered only when it carries a **meaningful**
hint: a concrete (non-placeholder) command, an MCP tool, a verification command,
a preferred flow, a non-empty forbidden-action / safety note, or a
**cross-reference that resolves** to a real entry/template.

**Entries with no actionable next step are exempt from the denominator** (so the
target isn't artificially 100%, and nobody is pushed to fake a hint). Two levers,
in order of preference:

1. **Give it a real hint (preferred).** Where a hint is natural, derive one
   rather than exempt — e.g. a path-convention entry can carry a path-specific
   `shrk why <path>` + `shrk check boundaries` hint, which makes the entry
   genuinely useful, not just un-penalized. This auto-derivation is a
   pack/project pattern (it needs the entry's own metadata); the engine's job is
   only the metric.
2. **`noAction: true` (the per-entry lever).** When a real hint genuinely isn't
   natural — a context-only overview, a glossary, an architecture thesis — set
   `noAction: true` on the entry to exclude it deliberately. This is the precise
   lever; prefer it over widening the coarse type floor.

As a conservative floor, purely-descriptive types (`business`, `decision`) are
exempt automatically. Don't grow that type list to chase coverage — reach for a
real hint, then `noAction`, before adding a type.
