# Changed-only preflight (R38)

`shrk preflight` orchestrates the right read-only gates for the
current change-set instead of running everything unconditionally.
It's the pre-commit / `--since <ref>` adapter that pairs with
`shrk dev cycle` (a fixed-sequence steady-state loop).

## Quick start

```bash
# print the gate plan without running anything
shrk preflight --explain

# run the plan against changes since main
shrk preflight --since main

# changed-only on a specific file list
shrk preflight --files packages/inspector/src/foo.ts,packages/cli/src/main.ts
```

## Flags

```
--since <ref>                git ref baseline (e.g. main, origin/main)
--staged                     use the staged set instead
--files a,b,c                explicit file list
--profile quick|standard|strict  default: standard
--explain                    print the gate plan and exit 0
--json                       emit the planner output as JSON
```

## Profile differences

| Gate | quick | standard | strict |
| --- | :-: | :-: | :-: |
| boundaries | run when engine src changed | run | run |
| imports | run when engine src changed | run | run |
| knowledge-stale | run when knowledge / src changed | run | run |
| templates-drift | run when templates / packs changed | run | run |
| self-config-doctor | run when sharkcraft/ or pack contrib changed | run | run |
| packs-signature | run when pack contributions changed | run | run |
| commands-doctor | run when CLI / catalog changed | run | run |
| safety-audit-deep | recommend (unless safety areas changed) | recommend (unless safety areas changed) | **run** always |
| tests | recommend | recommend | **run** when engine src changed |
| typecheck | recommend | **run** | **run** |

## Verdict

`shrk preflight` exits 0 unless a `Run` gate with `canFail: false`
fails. The summary line shows how many gates were run / skipped /
recommended.

The planner is exported as
`@shrkcrft/inspector / planChangedPreflight` and is pure data — the
CLI does the spawning.
