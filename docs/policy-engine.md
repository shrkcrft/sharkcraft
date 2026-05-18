# Policy engine

A unified report aggregating signals from rules, boundaries, ownership, packs,
and plans.

```bash
shrk policy list
shrk policy check
shrk policy check --plan <plan.json>
shrk policy check --bundle <id>
shrk policy check --json
```

Each check has `id`, `title`, `severity`, `checkType`, `message`,
`suggestedFix`, `relatedRules`. Sources currently aggregated:

- Boundary violations (`boundary:*`)
- Forbidden actions from action hints (`forbidden:*`)
- Ownership-required reviews (`ownership:required-review`) when a plan is
  provided
- Unsigned plans (`plan:unsigned`)
- Unverified packs (`pack:unverified:*`)

## MCP

`get_policy_report` exposes the report, read-only.
