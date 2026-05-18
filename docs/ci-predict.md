# CI predict (R33)

Local prospective view of "what would CI report if I pushed now?".
Read-only over `.sharkcraft/reports/*.json` — does not run commands.

## Commands

```bash
shrk ci predict [--profile github-pr|release|pack|self] [--from-reports <dir>] [--format text|markdown|json] [--report]
shrk ci would-fail  # alias
```

## Profiles

- `github-pr` — boundaries (changed-only), commands doctor.
- `release` — release readiness.
- `pack` — pack doctor.
- `self` — workspace doctor, self-config doctor, knowledge stale-check, templates drift, agent tests.

## Output

For each gate the report includes verdict (`pass | warn | fail | unknown`),
`summary`, `report` file name, and `nextCommand`. Missing reports are
listed separately with the suggested next command.

## MCP

- `get_ci_prediction` — read-only.

## Schema

`sharkcraft.ci-predict/v1`.
