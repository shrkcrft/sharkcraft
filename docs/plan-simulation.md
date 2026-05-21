# Plan simulation

`shrk plan simulate <plan.json>` predicts what `shrk apply` would do for a
saved plan, **without writing anything**.

## When to use it

- Before `shrk apply` on a v2 plan.
- During PR review (the simulation surface fits cleanly into a comment).
- When debugging an apply-time conflict — the simulator classifies each
  operation and explains the outcome.

## Usage

```
shrk plan simulate <plan.json> \
  [--format text|markdown|html|json] [--output <file>] \
  [--strict] \
  [--include-boundaries] [--include-impact] [--include-tests] \
  [--include-policies] [--include-ownership] [--include-memory] \
  [--diff] [--max-diff-lines N]
```

R24 adds `--diff` and `--max-diff-lines N`. With `--diff`, the report
carries per-file `beforeLineCount → afterLineCount`, an `operationDetail`
field for the op kind, and a unified-diff preview (truncated when long;
HTML wraps each diff in a static `<details>` block — no JS).

## What it reports

- **Per-file outcome**: `ready / skip-idempotent / conflict / modifies-existing / creates-new`.
- **Marker detection**: public API, barrel export, key tables, event registry, token registry.
- **Boundary impact**: current-state boundary violations on the planned paths, plus boundary violations the plan would *introduce* (computed from the re-rendered virtual contents when the template is in the live registry).
- **Ownership review**: files that match a `requiredReview: true` ownership rule.
- **Likely tests**: missing `*.spec.ts` companions for changed `src/**` TS files.
- **Required validations**: `bun test`, `shrk doctor`, `shrk check boundaries`, plus extras driven by the plan's surface (API report, packs doctor, …).
- **Affected constructs / recommended playbooks**.
- **Apply readiness**: one of `ready / ready-with-review / blocked-conflicts / blocked-policy / blocked-boundary / blocked-signature / blocked-missing-review`.

## Limitations

When the template id is not present in the live registry (e.g. a plan
generated against a previous version of the templates), the simulator
falls back to `expectedChanges` metadata — the planned virtual contents,
and therefore the introduced-boundary scan, are unavailable. The report
calls this out explicitly under `limitations`.

## Safety

- Read-only. Never writes source. Never runs a shell.
- MCP: `simulate_plan` is read-only.
