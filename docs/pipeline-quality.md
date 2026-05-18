# Pipeline quality

```bash
shrk pipelines lint [<id>]
shrk pipelines test [<id>]
```

`lint` checks: step ids, step types, template references resolve, command
catalog membership, human review markers before write/apply steps.

`test` verifies that template references resolve in the current registry.
