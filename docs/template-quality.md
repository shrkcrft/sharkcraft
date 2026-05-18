# Template quality

```bash
shrk templates lint [<id>]
shrk templates test [<id>]
shrk templates snapshot <id>
```

`lint` checks: title, description, variable documentation, required variables
with example/pattern, target-path safety, and placeholder leak detection.

`test` renders each template with sample variable values and reports
`renderedChanges` / `conflicts` / errors.
