# Dev cycle (R33)

`shrk dev cycle` orchestrates a deterministic sequence of read-only
check commands. It never auto-applies fixes; humans run the writes via
the CLI.

## Commands

```bash
shrk dev cycle --plan [--profile <id>]
shrk dev cycle --run  [--profile <id>] [--continue-on-error]
shrk dev cycle --until-green [--profile <id>] [--max-iterations N]
```

## Profiles

- `sharkcraft-self` — doctor / self-config doctor / knowledge stale-check / templates drift / test agent / commands doctor / safety audit.
- `pack-author` — packs doctor / contributions / conflicts / helper doctor / feedback rules doctor / self-config doctor.
- `project-consumer` — doctor / boundaries (changed-only) / conventions check / knowledge stale-check / templates drift.
- `release` — release readiness (strict) / release smoke / safety audit / product check / commands doctor.

Each step ships with a `canFail` flag. `--until-green` keeps iterating
until every non-`canFail` step exits zero.

## MCP

- `get_dev_cycle_plan` — read-only. MCP cannot run the cycle.

## Safety

- No auto-fix.
- No auto-apply.
- If a fix preview exists, the cycle prints the command but never runs
  it.

## Schema

`sharkcraft.dev-cycle/v1`.
