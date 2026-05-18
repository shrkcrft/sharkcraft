# `shrk lint` — unified lint verb (R53)

`shrk lint` runs the three per-kind lint surfaces — knowledge / rules /
templates — in one pass and aggregates the findings into a single
report. It's a pure aggregator: no new domain logic, no new checks.
The per-kind verbs (`knowledge lint`, `rules doctor`, `rules lint`,
`templates doctor`, `templates drift`) keep working unchanged.

## Quick reference

```bash
shrk lint                           # all kinds
shrk lint --kind knowledge          # focus
shrk lint --kind rules
shrk lint --kind templates
shrk lint --strict                  # exit non-zero on warnings too
shrk lint --fix-preview             # propagates to knowledge lint
shrk lint --json                    # stable aggregate shape
```

## JSON shape

```json
{
  "schema": "sharkcraft.lint/v1",
  "generatedAt": "...",
  "kind": "all",
  "strict": false,
  "fixPreview": false,
  "totals": { "errors": 0, "warnings": 2, "ready": true },
  "knowledge": {
    "errors": 0, "warnings": 0, "findings": 19,
    "categories": { ... },
    "staleReferences": 0
  },
  "rules": {
    "errors": 0, "warnings": 2, "findings": 4,
    "byCode": { ... }
  },
  "templates": {
    "totalTemplates": 2, "errors": 0, "warnings": 0,
    "passing": 2, "byCode": {}
  }
}
```

`totals.ready` is `true` iff zero errors and (when `--strict`) zero
warnings. The CLI's exit code is 0 iff `ready === true`.

## When to use which

| Use | Verb |
|-----|------|
| One-shot triage across all three kinds | `shrk lint` |
| Drill into a knowledge finding's stub fix | `shrk knowledge lint --fix-preview` |
| Drill into a rule's missing-action-hints | `shrk rules doctor --strict` |
| Drill into template drift detail | `shrk templates drift --min-severity warning` |
| Apply a stub fix | `shrk fix --action-hints --apply` |
| Apply a stale-reference fix | `shrk fix --knowledge-stale --apply --drop-stale` |
| Apply a related-id-unresolved fix | `shrk fix --template-drift --apply` |

`shrk lint` is the entry point. Drill in via the per-kind verb when
you need detail.

## Layer order

`shrk lint` lives in `packages/cli/src/commands/lint.command.ts` and
calls the existing inspector builders (`lintKnowledge`,
`diagnoseRuleQuality`, `buildTemplateDriftReport`,
`buildKnowledgeStaleReport`). No new inspector module was added.

## Related

- [`doctor.md`](./doctor.md) — `shrk doctor --blockers` is the
  must-fix view; `shrk lint` is the "everything I might want to clean
  up" view.
- [`knowledge-authoring.md`](./knowledge-authoring.md) — how findings
  become preview-only fixes and (R52/R53) in-place applies.
