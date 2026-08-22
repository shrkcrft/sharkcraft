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
- **`finish`** — the composite "safe to finish?" gate returns the tri-state
  directly: `1` if any deciding sub-gate failed, `2` if it evaluated **nothing**
  (a markdown-only change / an empty scope — never a green `0`), else `0`. The
  `--json` body carries both `verdict` and `exit`.
- **`wiring unprovided` / `wiring orphans`** — an empty `--changed-only` / `--base`
  scope is `2`; a real unprovided token is `1`.

## Surviving a pipe (`--exit-trailer`)

A true `2`/`1` **evaporates the moment stdout is piped**: `<gate> | head`,
`| grep`, `| tee` all report the *downstream* command's `$?` (a `head` that read
one line exits `0`), so the honest code is masked on the invocation an agent
reaches for first. Two stderr channels — which survive the pipe — keep the
verdict readable:

- When a gate/verify verb's stdout is **not a TTY** and its exit is **non-zero**,
  it prints a one-line note to **stderr**: `note: stdout is piped — $? reflects
  the downstream command, not shrk (exit N); use PIPESTATUS[0] or --exit-trailer
  …`. (A masked `0`→`0` is harmless, so the note is reserved for a real `1`/`2`.)
- **`--exit-trailer`** (global) prints the verdict as the **last stderr line**,
  `shrk-exit: <code>`, on any code — a machine channel a pipe can't swallow:

  ```bash
  shrk check boundaries --exit-trailer | head   # stdout piped to head…
  #   …stderr still carries:  shrk-exit: 0
  ```

The shell-native answer (`set -o pipefail` / `${PIPESTATUS[0]}`) still works and
is bash-only; the trailer removes the need to remember it per-chain.

## Implementation

`packages/cli/src/exit-codes.ts` is the single source of truth: the `ExitCode`
enum plus `promoteForStrict(code, strict)`, applied once in `runCli` after the
handler returns. The same module owns `emitPipeExitSignal(commandPath, code, …)`
— also called once in `runCli` — which writes the piped-stdout note and the
`--exit-trailer` line for the gate-verb set (`isGateVerb`). The `gen --typecheck`
pre-write gate already refuses-to-nonzero rather than emit an unverified artifact
— this generalizes that instinct across the whole gate surface, adding the third
code so "unverified" is distinguishable from "broken."

## `3` — usage error (gate verbs)

`2` and `3` answer different questions and demand different responses:

| Code | Means | What to do |
|---|---|---|
| `2` | the gate RAN but proved nothing — empty scope, or every rule skipped | investigate the **rules** (start with `shrk gates coverage`) |
| `3` | the gate never STARTED — unloadable config, unknown rule id, bad flag value | fix the **invocation** or the config |

`3` is scoped to the gate verbs (`check wiring`, `policy-lint`, `baseline *`,
`generated *`, `gates *`, `registry *`). Non-gate verbs keep returning `2` for
usage errors — widening the split across the whole CLI would churn a documented
contract far beyond what it buys.

## A skipped rule is never masked by a passing sibling

The subtle one. A run with one passing rule and one whose selector went stale
used to print the truth and then return the wrong number:

```
No wiring violations among the 1 rule(s) evaluated — 1 of 2 NOT verified. Not a full green.
  $? = 0        ← an agent chaining `&& next` marched straight past
```

The exit code now matches the sentence:

- **any** rule skipped, nothing failed → `2` (partially verified is not verified)
- a skipped rule whose severity is `error` → `1`, because **`failOnEmpty`
  defaults to true for error-severity rules**. An error rule exists to block a
  build; one matching zero subjects is a bug in the rule, not a pass.
- `warning`-severity rules default to `failOnEmpty: false`, since a warning
  plane may legitimately cover an empty set. Set the field explicitly to
  override either default.

