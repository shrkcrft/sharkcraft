# Drift detection

`shrk drift` reports architecture drift: situations where the repository
diverges from what its own SharkCraft configuration says.

Categories:

| Category | Severity | What it catches |
|---|---|---|
| `boundary` | error/warning | Boundary rule violation (forbidden import). |
| `preset-composition` | error | Cycle / unknown composed preset. |
| `preset-reference` | warning | Preset references a missing template/rule/path. |
| `pipeline-template-link` | warning | Pipeline step references an unknown id. |
| `template-relationship` | info | Action hint declares a `relatedTemplate` that's not registered. |

```bash
shrk drift
shrk drift --json
shrk drift --skip-boundaries        # skip the import scan
```

MCP: `get_drift_report` returns the same shape.

Drift detection runs the boundary scan by default. Pass `--skip-boundaries`
on very large repos to skip the scan (and miss those findings).
