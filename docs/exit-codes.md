# Exit-code contract (gate / verify / check verbs)

SharkCraft's value proposition to an agent is *a gate it can chain*. An agent
almost never parses a banner — it chains `shrk <cmd> && <next>` on the **exit
code**. So the exit code, not the STDOUT prose, is the contract.

alpha.24 / alpha.25 made the STDOUT verdicts honest (`not verified`,
`degraded`, `0 rules evaluated`, `this is not a pass`) but left the exit code
returning `0` over those same unverified paths. alpha.26 finishes the job: one
consistent, documented exit code across every gate / verify / check verb, so a
chained gate can finally tell apart **passed**, **failed**, and **never ran**.

## The three codes

| Code | Name | Meaning |
|---|---|---|
| `0` | verified pass | Checks ran over a **non-empty** scope and passed. Never returned when zero units were evaluated. |
| `1` | failure | Checks ran and found violations. |
| `2` | not-verified | **Indeterminate**: empty evaluation scope, degraded fallback, short-circuit, timeout, or "refused to run." Also the CLI's long-standing usage-error code — both mean "did not produce a verified result." |

`2` is deliberately distinct from both pass and fail so a chain can branch on
it:

```bash
shrk check wiring --changed-only
case $? in
  0) echo "wiring verified" ;;
  1) echo "wiring violations — fix them" ;;
  2) echo "wiring NOT verified (nothing in scope) — decide explicitly" ;;
esac
```

## `--strict` — treat unverified as failure

A global `--strict` flag promotes a not-verified (`2`) result to a
failure-class nonzero (`1`), so an agent can opt into "unverified = failure"
for a hard CI gate with one switch:

```bash
shrk check wiring --changed-only --strict && deploy   # 2 → 1, so `&& deploy` stops
```

`--strict` is also an established per-command flag (e.g. `check --strict`
promotes warnings to failures, `doctor --strict=warnings`). Those local
meanings are preserved — the global promotion layers on top and only affects a
command that actually returned `2`. A real pass (`0`) or failure (`1`) is never
touched.

## Verbs that honor the contract

- **`check wiring` / `check registry-lifecycle`** — `0 rules / 0 registrations
  evaluated` in scope is `2` (not a green `0`). Text and `--json` both carry
  the verdict; the JSON adds an `exitCode` field so a machine consumer branches
  without re-deriving it.
- **`registry lifecycle`** — a timed-out (budget-exceeded) or zero-registration
  scan is `2`.
- **The graph/query family** (`graph cycles|hubs|callers|impact|…`) — an
  unrecognized/misspelled flag is rejected with `unknown option '--x'` and exits
  `2` rather than silently swallowing the flag and reading as a confident `0`.

## Implementation

`packages/cli/src/exit-codes.ts` is the single source of truth: the `ExitCode`
enum plus `promoteForStrict(code, strict)`, applied once in `runCli` after the
handler returns. The `gen --typecheck` pre-write gate already refuses-to-nonzero
rather than emit an unverified artifact — this generalizes that instinct across
the whole gate surface, adding the third code so "unverified" is distinguishable
from "broken."
