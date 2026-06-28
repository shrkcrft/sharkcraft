# Dev cycle (R33)

The **dev-cycle plan** is a deterministic sequence of read-only check
commands (validation gates). It never auto-applies fixes; humans run the
writes via the CLI.

> **The `shrk dev cycle` CLI verb has been removed.** The plan is now
> exposed read-only via the MCP `get_dev_cycle_plan` tool, and
> [`shrk preflight`](./preflight.md) is the CLI orchestrator that selects
> and runs the right gates for the current change-set.

## Access

```bash
shrk preflight                 # run the change-aware gates (CLI orchestrator)
shrk preflight --explain       # print the gate plan without running it
shrk preflight --profile strict
```

- MCP: `get_dev_cycle_plan` — read-only; returns the gate plan. MCP cannot
  run the cycle.

## Profiles

- `sharkcraft-self` — doctor / self-config doctor / knowledge stale-check / templates drift / test agent / commands doctor / safety audit.
- `pack-author` — packs doctor / contributions / conflicts / helper doctor / feedback rules doctor / self-config doctor.
- `project-consumer` — doctor / boundaries (changed-only) / conventions check / knowledge stale-check / templates drift.
- `release` — release readiness (strict) / release smoke / safety audit / product check / commands doctor.

Each gate ships with a `canFail` flag; gates that are not `canFail` are
the ones whose failure blocks the change-set.

## MCP

- `get_dev_cycle_plan` — read-only. MCP returns the gate plan but cannot
  run it.

## Safety

- No auto-fix.
- No auto-apply.
- If a fix preview exists, the plan surfaces the command but never runs
  it.

## Schema

`sharkcraft.dev-cycle/v1` — emitted by the `get_dev_cycle_plan` MCP tool.
