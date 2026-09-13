# CI predict (R33) — removed

Local prospective view of "what would CI report if I pushed now?".
Read-only over `.sharkcraft/reports/*.json` — does not run commands.

> **Removed.** The former `ci predict` / `ci would-fail` CLI verbs were removed
> (advisory, untested, not on the spine). To see what CI would report, run the
> gates themselves: `shrk quality` (every check and rule plane, each failure
> with its repro command) or `shrk finish` (the changed-only "safe to finish?"
> composite). The notes below describe the removed verb, for reference.

## Profiles

- `github-pr` — boundaries (changed-only), commands doctor.
- `release` — release readiness.
- `pack` — pack doctor.
- `self` — workspace doctor, self-config doctor, knowledge stale-check, templates drift, agent tests.

## Output

For each gate the report includes verdict (`pass | warn | fail | unknown`),
`summary`, `report` file name, and `nextCommand`. Missing reports are
listed separately with the suggested next command.

An unmeasured verdict is never a pass (round 13). The self-config probe reads
only `ok` as `pass`: `unverified` (a dead unit or an id that could not be looked
up — the doctor exits `2`, so the CI step fails) predicts `fail`, and a verdict
the probe does not know is `unknown`. It read every value but `errors` /
`warnings` as `pass`, including the `unverified` report `shrk self-config
report` writes. And any cached report that carries its own non-zero
`exitCode` (a verdict verb's `--json`) never predicts `pass` — nor `warn`: a
`verdict: "warnings"` report written by `self-config doctor --strict --json`
(exit `1` on a warning) predicts `fail` — whatever field its probe keys on.

## MCP

- `get_ci_prediction` — read-only.

## Schema

`sharkcraft.ci-predict/v1`.
