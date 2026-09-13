# Exit-code contract (gate / verify / check verbs)

SharkCraft's value proposition to an agent is *a gate it can chain*. An agent
almost never parses a banner — it chains `shrk <cmd> && <next>` on the **exit
code**. So the exit code, not the STDOUT prose, is the contract.

alpha.24 / alpha.25 made the STDOUT verdicts honest (`not verified`,
`degraded`, `0 rules evaluated`, `this is not a pass`) but left the exit code
returning `0` over those same unverified paths. alpha.26 finishes the job: one
consistent, documented exit code across every gate / verify / check verb, so a
chained gate can finally tell apart **passed**, **failed**, and **never ran**.

## The codes

| Code | Name | Meaning |
|---|---|---|
| `0` | verified pass | Checks ran and passed over the WHOLE requested scope: every coverage has examined == expected, is never capped, never zero — or the gap was explicitly accepted (a valve below) and the acceptance is printed. Never returned over an unexamined scope. |
| `1` | failure | Checks ran and found violations. |
| `2` | not-verified | **Indeterminate**: empty evaluation scope, degraded fallback, short-circuit, timeout, or "refused to run." On a verb that is NOT a verdict verb it is also the usage-error code — both mean "did not produce a verified result." |
| `3` | usage error | A verdict verb never STARTED: an unknown subcommand or flag, a bad flag value, an unloadable config, an unknown rule id (see the `3` section below). |
| `78` | refused by the surface gate | The command exists but is not callable in this repository: experimental and not enabled, tool-maintenance outside SharkCraft's own repo, or denied by `surface.disabled` (see the `78` section below). Never a check verdict. |
| `70` | the tool's own install is broken | Only from the bin bootstraps (`shrk`, `shrk-mcp`; round 13): a workspace dependency of the INSTALLED TOOL is not linked, so its module graph could not load and nothing ran. One stderr line names the dependency, the package that needs it and where to run the install (see the `70` section below). Never a check verdict. |

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
- **`check registry-lifecycle` / `registry lifecycle`** (one body, settled
  through the gate envelope) — a missing remover is `1` even in a partial
  scan; a CAPPED (`--limit`), timed-out, interrupted or over-budget scan is
  `2` and names the `--offset <n>` that continues it; an empty scope or zero
  registrations is `2` (`--allow-empty` → `0`); a malformed/unknown flag is
  `3`. `--json` carries the real `exitCode` and the `gate` envelope.
- **`recommend --require-confident`** (round 11, opt-in) — `recommend` is not a
  gate and exits `0` by default. With `--require-confident`, a query nothing
  matched with confidence (`confident: false`, verdict `no-confident-match` /
  `no-match`) is `2`, so an agent can branch on it; global `--strict` promotes
  it to `1`. `--json` then carries `exitCode`. An invalid `--min-score` is `3`.
- **The graph code-intelligence subverbs** (`graph cycles|why|hubs|callers|impact|importers|…`)
  — an unrecognized or misspelled flag is refused BEFORE the subverb runs, never
  swallowed into a confident `0`. The message is THE one refusal format (round
  13: ``! `shrk graph cycles`: --x is not a flag of this command. Did you mean
  --…?`` plus an `Accepts:` line) and names the subverb, the flags it accepts
  and the closest one. The exit is
  `usageExitFor`'s: `3` on the verdict subverbs (`graph cycles`, `graph why`),
  `2` on the others (`hubs`, `callers`, `impact`, `importers`, …) — see
  *Invocation errors the dispatcher refuses* below.
- **`check boundaries` / `diff-check`** (round 11 — both settled through the
  gate envelope, `--json` carries `exitCode` and `gate`) — `2` for zero rules
  loaded, a rule whose `from` globs matched nothing (a warning rule), a rule
  that examined only part of its scope (a dead scope glob), an empty or
  ungoverned `--changed-only` selection, or a rule edit kept out by
  `--no-rule-escalation`; `--allow-empty` accepts an EMPTY selection only. `1`
  for an error violation, an errored rule (invalid, unloadable, or a listed
  rule file that does not exist), a stale exception, an `error` rule matching
  nothing (`failOnEmpty`), or a dead unit under `--fail-on-dead-units`. `3` for
  an unknown flag, an unknown `--rule`, or an unloadable `--rule-file` /
  `--diff-against`. A changed-scope run ESCALATES a rule whose definition the
  changeset touched, so a rule edit's violations are never "legacy".
  `diff-check` over an empty diff is `2`, never "Diff passes the gate".
- **`knowledge stale-check` / `knowledge verify`** (round 11 — settled through
  the gate envelope, `--json` carries `exitCode` and `gate`) — every entry in
  scope is verified, stale or UNVERIFIABLE (no checkable reference). STRICT by
  default: any unverifiable entry is a coverage shortfall, so the run is `2`,
  never `0`, unless `--min-referenced <ratio>` / `knowledgeCheck.minReferenced`
  accepts it (printed). `1` for a stale / missing reference, a floor not met
  (`--min-referenced`), `--require-references` over an unverifiable entry, or
  an opted-in `--fail-on` category. `2` also for loading 0 entries from the
  resolved root (a nested package, a missing `sharkcraft/`, a config that
  failed to load — the output names the root and the configured ancestor;
  `--allow-empty` never clears these) and for an empty changeset scope
  (`--allow-empty` accepts that). `3` for an unknown `--fail-on` category or a
  malformed `--min-referenced` / `--stale-after` / `--as-of`.
- **A required input selector omitted** (`tests missing`, `tests impact`,
  `owners impact`, `impact`) — no `--files` / `--since` / `--staged` / `--plan`
  / `--bundle` (or positional) is a usage error, `3` with the usage line, never
  zero bytes and exit `0`; a selector that resolved to 0 files (`--since HEAD`
  on a clean tree) is `2` — nothing was analysed.
- **`finish`** — the composite "safe to finish?" gate returns the tri-state
  directly: `1` if any deciding sub-gate failed, `2` if it evaluated **nothing**
  (a markdown-only change / an empty scope — never a green `0`), else `0`. The
  `--json` body carries both `verdict` and `exit`. A deciding sub-gate that
  passed over only PART of its scope (a partial wiring rule; the orphan query
  over a stale index) is `partial` — the same word in the text line and in
  `--json` `gates[].status`, with its `shortfall` — and the composite is `2`.
- **`wiring unprovided` / `wiring orphans` / `wiring chain`** — no
  `registrationGraph[]` declared examined nothing: `2` (text, `--json`
  `exitCode` / `verdict`, the trailer), `--allow-empty` → `0` with the acceptance
  printed (round 11 review — it was `0`, while `check wiring` / `gates check` said
  `2` over the same config). An empty `--changed-only` / `--base` scope is `2`; a
  real unprovided token is `1`. Round 13: `unprovided` / `orphans` fold every
  idiom's ROLE record (the role authority `gates check` reads), so an idiom whose
  declared / provided / consumed role matched no file is `2` NOT VERIFIED —
  never a `✓` at `0` — and finish's `unprovided` sub-gate and MCP
  `get_wiring_graph` say the same; their `--json` always carries `exitCode`,
  `verdict`, `shortfalls`, `accepted`, `coverage` and the `gate` envelope.
- **`conventions check`** (round 13) — `2` NOT VERIFIED over an empty file
  scope, no convention declared, or a convention file that never loaded
  (`--allow-empty` accepts the first two, printed, never the third); `1` on an
  `error`-severity hit; `3` on a usage error. It printed `ok — no violations.` at
  `0` over nothing.
- **The data-defined gate verbs** (`check wiring`, `policy-lint`, `baseline
  check`, `generated check`, `docs references check`, `gates check`, `gates
  coverage`) — every rule and the run carry a `coverage` record (below); a rule
  that passed over only PART of its scope is `partial`, and the run is `2`.
  `check wiring`, `policy-lint` and `gates check` with **no rules declared** (or
  nothing in the `--changed-only` scope) are `2`, no longer `0` — `--allow-empty`
  accepts that explicitly (exit `0`, and the acceptance is printed).
- **`check orphans`** — nothing deleted is `2` ("orphan check skipped" is not a
  pass), and so is a diff none of whose deleted files the code-graph index knows;
  `--allow-empty` accepts the empty diff for a per-commit hook. A surviving
  importer is still `1`. A delete checked against a STALE index is `2` too: a
  file added or edited since `shrk graph index` may import the deleted code and
  the index never read it, so every deleted file is unexamined until the
  pre-delete tree is re-indexed (the `index` line and `--json`
  `indexDivergence` name those files; `--allow-empty` does not waive it). Only
  files the graph indexes are in scope — a deleted README or tracked
  `dist/*.js` is not a gap.
- **`gate`** — an advisory `warn` stays `0` unless `--strict` (then `1`), but a
  gate that examined only part of what it was asked to (a wiring rule that
  passed over part of its scope; a config that did not load) settles the
  proposed `0` to `2` with a `NOT VERIFIED` line — text, `--json` (which gains
  `exitCode`, `verdict`, `shortfalls`, `accepted`) and `--markdown` alike.
- **`quality`** — a gate that examined nothing (zero context/agent tests, zero
  boundary rules) is `skipped`, never `passed`: a deliberate skip when the gate
  is optional, not verified (`2`) when it is required (`requireContextTests`, …
  or `--strict`). A rule that passed over part of its scope is an accidental
  skip, so the verdict cannot be `pass`. `--json` carries `verdict:
  "not-verified"`, and MCP `get_quality_report` / the dashboard read `overall:
  "not-verified"` over a partial or unrun gate — never `pass`.
- **The pack verbs** (round 11) — `packs contributions` exits `1` when an
  error-severity conflict exists (a contribution file that failed to load, a
  duplicate id), like `packs conflicts`, and (round 12) when a loader REJECTED
  a declared entry; it exits `2` NOT VERIFIED when only references whose kind's
  registry is empty or undeclarable remain (its `By file:` report names them)
  — settled through `settleVerdict`, `--json` carries `exitCode` / `verdict` /
  `shortfalls` / `report`. A view holding no contributed file (an empty
  project, or a filter selecting none) is also `2` — nothing was examined —
  unless `--allow-empty` accepts it; an unknown `--kind` / `--pack` is a usage
  error, `3`, naming the known values (round 12 review — it narrowed the view
  to nothing and printed ✓ at `0`). `packs test --load` exits `1` on an
  `asset-entry-rejected`, and `packs doctor` / `self-config doctor` exit `1` on
  a rejected entry (`contribution-entries-rejected` / `<kind>-invalid`).
  `packs test --typecheck`,
  `packs doctor --typecheck` and `packs release-check --typecheck` settle a
  typecheck that examined 0 TS files (or could not start TypeScript) to `2`
  with a `NOT VERIFIED` line — never a pass; a type error is `1`.
  `packs signature-status` is `1` for a stale signature and `2` for a signed
  pack whose freshness could not be verified (its signature records no content
  digests). `--json` carries `exitCode` / `verdict` / `shortfalls`.
  `packs doctor` settles against the packs it discovered — zero is `2`
  (`--allow-empty` → `0`) — and against compiled contribution artifacts: one
  with no build record (no source map with `sourcesContent`, no signed digest)
  was never compared to its source, so it is `2` by default and `1` under
  `--strict` / `--release`. A typecheck whose SDK (`@shrkcrft/*`) is not
  installed in the pack is a not-run `2` ("SDK not installed"), never pack
  errors. `passed` in `packs doctor` / `packs release-check --json` is the
  settled verdict (`exitCode === 0`).
- **`templates doctor`** (round 11) — folds `templates lint`'s errors (an
  invalid change operation, a malformed remainder, an unsafe target): a
  template lint fails is `1` here too, never "Clean". `2` when no template is
  registered (`--allow-empty` → `0`) or a template's `changes()` threw with
  sample variables (its operations were never checked).
- **`helper doctor`** (round 11) — `1` for an error issue (a helper file that
  failed to load or is missing, an invalid helper, a duplicate id); `2` when no
  helper file exists at all (`--allow-empty` → `0`).
- **The other round-11 verdict verbs** — each settles through `settleVerdict`;
  `--json` carries `exitCode`:
  - bare **`check`** (the doctor / knowledge / templates / pipelines / packs
    sweep) is `2` over a doctor coverage shortfall (e.g. a compiled pack build
    with no build record), never `OK`. A group with nothing to validate (zero
    knowledge entries, templates, pipelines or packs) renders `SKIP` (JSON
    `status: "skipped"`), never `OK`: a deliberate skip by default, NOT VERIFIED
    (`2`) under `--strict` — `shrk quality`'s aggregate rule. One group asked for
    ALONE (`check packs`, `check templates`, `check knowledge`, `check pipelines`)
    settles against that group's own doctor coverage — zero packs / templates /
    entries / pipelines is `2` (`--allow-empty` → `0`), exactly as `packs doctor`
    and `templates doctor` answer (round 11 review: `check packs` said OK at `0`);
  - **`arch check`** — `1` for an error violation; `2` with no code-graph store
    (0 files analyzed — the same diagnostic the quality-gates arch gate skips
    on and `gate baseline --refreeze` refuses), never "No violations.";
  - **`check imports`** — `1` for an error finding; `2` when the scope held
    nothing to read (an empty `--changed-only` / `--since` changeset, or no
    .ts/.tsx source — `--allow-empty` → `0`) or an in-scope file could not be
    read. An empty changeset scans nothing: it never widens to the whole tree;
  - **`self-config doctor`** (and **`self-config report`**, which settles the
    same verdict — round 13), **`registrations doctor`**, **`scaffolds doctor`**,
    **`search tuning doctor`** — `1` for errors (warnings under `--strict`, dead
    units and stale LOCAL `expectEmpty` markers under `--fail-on-dead-units`),
    `2` for a dead selector or an unverifiable unit; a unit marked `expectEmpty`
    whose target does not exist yet is accepted, printed (`0`). The
    registrations, scaffolds and search tuning doctors are `2` over nothing
    declared, too (`--allow-empty` → `0`, printed) — the answer every asset
    doctor gives an empty input;
  - **`checks doctor`** / **`conventions doctor`** — `1` for a declaration that
    can never run (or a warning under `--strict`), `2` for nothing declared or a
    file never read;
  - **`test agent`** / **`test context`** — `1` a failed test, `2` a test that
    could not be evaluated or none configured, `3` an `--id` that selects
    nothing;
  - **`reuse coverage`** — `1` a dead curated entry, an `importPath` that does
    not expose its symbol, or `--min-coverage` unmet; `2` a missing or stale
    graph index (a changed file or package entry) or a package whose exports
    were not walked;
  - **`gates try`** — `1` the candidate's selfTest failed or the candidate is
    misconfigured, `2` a partial or uninspectable candidate, `3` a malformed
    spec.
- **The bless steps** — `baseline update` refuses a rule whose value came from
  an incomplete read (a file over the read cap) and exits `2`: nothing is blessed
  for it. `generated update` writes the aligned regen over the committed paths
  in place, never writes an output it could not read, and exits `1` when the
  tree is not in sync.
- **Absence answers over an incomplete read** — `registry <name>
  list|exists|where|duplicates` over an inventory that matched 0 ids (`1` with
  `failOnEmpty`) or was not fully read, and `wiring unprovided|orphans` when the
  missing provider or consumer could sit in an unread file, are `2` — never a
  membership answer, never a pass.

## Coverage — the scope behind a clean verdict (round 11)

Every verdict carries what it EXAMINED next to what it was ASKED to examine
(`IVerdictCoverage` in `@shrkcrft/core`: `unit`, `expected`, `examined`,
`capped?`, `unexamined?`, `root?`, `reason?`, `acceptedBy?`, `acceptedRatio?`).
One rule — `coverageShortfall` — decides whether a gap vetoes a clean verdict,
and one guard — `settleVerdict`, applied inside `buildGateEnvelope` — applies it
to the exit:

| Proposed | Coverage | Settled |
|---|---|---|
| `0` | complete (examined == expected > 0, not capped) | `0` |
| `0` | any shortfall — partial, capped, or nothing to examine | `2` |
| `0` | a gap waived by an explicit valve | `0`, with `accepted by <valve>: …` printed |
| `1` / `2` / `3` | anything | unchanged |

A capped scan is never acceptable. An empty scope is accepted only by an
unconditional valve (`--allow-empty`), never by a ratio. The shortfall is
printed ON the verdict line — `NOT VERIFIED: <rule>: examined 2 of 3 registered
tokens, 1 registered with no declared site this selector produces: C_H (this is
not a pass)` — and carried in `--json` as `gate.shortfalls` / `rule.shortfall`.

The valves are explicit inputs, never defaults:

| Valve | Accepts | Where |
|---|---|---|
| `--allow-empty` | a request that covered zero units (no rules declared, nothing in scope, nothing deleted, no tests / helpers / templates / packs / checks / conventions / registration hints / scaffold patterns / search tuning configured) — never rules that exist but checked nothing, and never a load failure | `check wiring`, `check boundaries`, `check orphans`, `check registry-lifecycle` / `registry lifecycle`, `check packs` / `templates` / `knowledge` / `pipelines`, `wiring unprovided` / `orphans` / `chain`, `policy-lint`, `gates check`, `finish`, `diff-check`, `impact --deleted`, `knowledge stale-check` / `verify`, `reuse coverage`, `test agent` / `test context`, `helper doctor`, `templates doctor`, `packs doctor` / `test` / `signature-status` / `contributions`, `checks doctor`, `conventions doctor` / `check`, `self-config broken-links`, `registrations doctor`, `scaffolds doctor`, `search tuning doctor` |
| `--min-referenced <ratio>` · `knowledgeCheck.minReferenced` | a share of knowledge entries with no checkable reference (unverifiable); a ratchet too — below the floor is `1` | `knowledge stale-check` / `verify` |
| `registeredExtras` | a subset wiring rule's registered tokens the declared selector is known not to produce (literal ids, or `'allow'`) | the rule |
| `expectEmpty: true` (on a baseline rule) | a fence's asserted-empty OUTPUT — only over live or intended-empty inputs (round 13: a fence over a dead input is `1`); on a `ceiling`, an empty measurement | the rule |
| `{ pattern, expectEmpty: true }` (on a list entry) | one selector unit whose target does not exist yet — accepted while nothing matches, reported went-live once something does; a rule whose every primary inclusion unit is intended-empty and matched no file is accepted ([intended-empty.md](intended-empty.md)) | every markable list |

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
`--exit-trailer` line for the gate-verb set (`isGateVerb`). That set,
`GATE_VERB_PATHS`, is the exported verdict-verb registry. Round 11 registered
the verdict verbs it touched — its review found seven it had missed (`boundaries
suggest`, `packs contributions`, `self-config resolve`, `checks list`,
`recommend` for its `--require-confident` 2, `drift` and `architecture
violations`), registered them too, and extended the contract test to every
handler that advertises an exit code or returns `ExitCode.NotVerified` — the data-defined gate verbs (`gates check|coverage|try|scaffold-selftest`,
`policy-lint`, `baseline check|update`, `generated check`, `docs references
check`), `quality`, `knowledge stale-check|verify`, bare `check`, `check
registry-lifecycle`, `reuse coverage`, the test runners (`test agent|context`) and
the asset doctors (`self-config` doctor / broken-links, `registrations`, `scaffolds`, `search tuning`,
`packs`, `templates`, `checks`, `conventions`, `helper`) — until then
`--exit-trailer` printed nothing on the verbs most often piped in CI. A new verdict verb adds itself there;
`r75-verdict-coverage-contract.test.ts` fails otherwise — for a gate-envelope emitter,
and for every CLI file that settles through `settleVerdict(` (its two-way
settle-site ledger names each file's verbs, or a reasoned exemption such as
the flag-keyed `impact --deleted`). Paths are up to three
tokens (`VERDICT_PATH_TOKENS`) and an entry covers every deeper path under it,
so register the shortest path that is a verdict and nothing wider: `docs
references check` is three tokens because `docs references list` / `explain`
are informational and must not print `shrk-exit: 0` as if they were gates. The `gen --typecheck`
pre-write gate already refuses-to-nonzero rather than emit an unverified artifact
— this generalizes that instinct across the whole gate surface, adding the third
code so "unverified" is distinguishable from "broken."

## `3` — usage error (gate verbs)

`2` and `3` answer different questions and demand different responses:

| Code | Means | What to do |
|---|---|---|
| `2` | the gate RAN but proved nothing — empty scope, or every rule skipped | investigate the **rules** (start with `shrk gates coverage`) |
| `3` | the gate never STARTED — unloadable config, unknown rule id, bad flag value | fix the **invocation** or the config |

`3` is scoped to the verdict verbs — exactly the `GATE_VERB_PATHS` registry.
Non-verdict verbs keep returning `2` for usage errors — widening the split across
the whole CLI would churn a documented contract far beyond what it buys.

An unloadable config (or no `sharkcraft/` folder) is `3` on every verdict verb
whose rules live in it: `check wiring`, `policy-lint`, `gates check|coverage`,
`baseline check`, `generated check`, `docs references check`, `reuse coverage`,
`registry <name> list|exists|where|duplicates` and `wiring
unprovided|orphans|chain` (round 11 review — `check wiring`, the registry and
the wiring queries returned `1`, which reads as violations; `--json` carries
`exitCode: 3`). A verb that can run without its config does not refuse: it
reports what the failed load left unexamined as a coverage gap, `2`, never a
pass — `check registry-lifecycle` (the configured skip set was never applied)
and `knowledge stale-check`.

### Invocation errors the dispatcher refuses (round 11)

The split is one function, `usageExitFor(path)` in `packages/cli/src/exit-codes.ts`
(`3` when `isGateVerb(path)`, else `2`), read by the dispatcher guard and the
post-run unknown-flag detector alike:

- an unknown subcommand (`shrk doctor zzbogus` → `3`, `shrk check rules` → `3` —
  bare `check` is a verdict verb), an unknown bare token under a command group
  (`shrk templates lst` → `2`, was group help at `0`), or a verb-shaped token that
  is neither a subverb nor an existing file (`shrk api-diff status` → `2`, was an
  ENOENT);
- a flag outside a handler's declared set (`shrk gates check --chnged-only` →
  `3`; `shrk graph cycles --typo` → `3`, `shrk graph importers x --typo` → `2`);
- a flag no documentation of the command names — its usage, the command index at
  or below its path, or the ledger of flags its code reads behind a branch
  (`UNDOCUMENTED_FLAG_READS`, locked two-way against the code) — is refused
  **before the body runs** (`shrk check --tag auth` → `3` with no sweep printed,
  `shrk export claude-md --zz-bogus` → `2`; `shrk baseline update --dry-rn` → `3`
  and nothing is written — it used to perform the bless write first). A
  documented-but-unread flag never changes the exit, and presentation flags
  (`--json`, `--verbose`, …) are only warned about, after the run. A handler that
  re-executes its argv in a child (`smart-context`) declares its complete flag
  set, so the guard judges it before anything spawns.

The command-string resolver (`resolveCommandString`) runs this same judgement
(`judgeInvocation`), so a string an asset, a doc or guidance prescribes is
certified only if the dispatcher would run it.

`--help` / `-h` anywhere before `--` short-circuits to help at `0` and runs
nothing. The global flags (`--cwd`, `--strict`, `--no-hints`, `--exit-trailer`,
`--compress*` — one list, `dispatch/global-flags.ts`) are accepted leading,
in-path or trailing (`shrk --no-hints scaffolds list`). See
[command-discovery.md](command-discovery.md).

## Known gaps (round 11)

- **Spec 1.2#5's registry-wide sweep was not implemented.** The required-selector
  fix covers the verbs the spec named (`tests missing|impact`, `owners impact`,
  `impact`, `knowledge|templates|paths search`: no selector → 3, a selector
  resolving to 0 files → 2), locked by `r75-required-selector.test.ts`. The
  property "every per-item query verb with its selector omitted prints something
  and never exits 0" was NOT swept over `buildRegistry().listAll()`: running
  every registered verb with no arguments would execute write verbs, so a new
  per-item verb is held only by its own test.
- `impact --deleted` settles 0/1/2 but is not a registered verdict verb (its
  verdict is keyed by a flag, and the registry keys on positional paths), so a
  bad flag on `impact` still exits 2.

## `78` — refused by the surface gate (round 11)

A command the surface gate refuses exits `78` before its body runs. By default
stderr names the reason and the remedy and stdout is empty; with `--json` (or
`--format json`) stdout carries the structured refusal instead —
`sharkcraft.surface.not-enabled.v1`, with a `reasonCode` — and stderr is empty.
It is **never** a check verdict — branch on it separately from `0`/`1`/`2`/`3`.
One gate, three reasons:

| `reasonCode` | When | Remedy |
|---|---|---|
| `experimental` | an experimental command not in `surface.enabled` | `shrk surface enable <cmd> --write` |
| `tool-maintenance` | a command that maintains SharkCraft itself (`docs check`, `examples check`, `self audit`, `install smoke`, `release readiness`, `release smoke`, `commands doctor` / `ux-check` / `overlaps` / `legacy` / `machine`, `rounds …`, `diff rounds`) run outside SharkCraft's own repository | `surface.enabled` (it does not apply to your repo — this is not a check failure) |
| `disabled` | a `surface.disabled` selector (exact path or `'<group> *'`) denies it | `shrk surface allow <selector>` |

The MCP gate refuses the matching tools (`isError`) with the same reason. See
[surface-tiers.md](surface-tiers.md).

## `70` — the tool's own install is broken (round 13)

The emitted CLI imports its sibling packages by bare name (`@shrkcrft/x`), and
Node resolves each one through a per-package link that `bun install` creates
(`packages/<p>/node_modules/@shrkcrft/<dep>`). tsc and Bun resolve the same
imports through tsconfig paths and never consult those links, so a tree built
without re-running the install builds green and then dies under node at ESM
load: on every verb, `--version` included, and in the MCP server, before any
handler runs and whatever the repository or packs. The bin bootstraps — `shrk`
→ `dist/shrk.js` and `shrk-mcp` → `dist/shrk-mcp.js`, which load
`dist/main.js` — turn that one failure into one stderr line:

```
shrk: workspace dependency @shrkcrft/plugin-api (needed by @shrkcrft/framework-scanners) is not linked — run `bun install` in /path/to/sharkcraft
```

and exit `70` (sysexits `EX_SOFTWARE`, next to `78` `EX_CONFIG`). `1` would
read as violations and `2` as "ran, proved nothing"; a broken install ran
nothing. Branch on it separately from `0`–`3`: the fix is in the tool's own
tree (or its install), never in the repository being checked. Any other load
error is rethrown untouched — the same message, source line and exit as
running `dist/main.js` directly, whose raw `ERR_MODULE_NOT_FOUND` stack is what
`70` replaces.

The build refuses such a tree before it gets that far. `bun run build`,
`bun run build:dist` and the `workspace-links` step of `bun run
release:preflight` exit `1` with the same sentence, and also for a src import
of a workspace package its `package.json` does not declare in `dependencies` /
`peerDependencies` (a devDependencies-only declaration included). Preflight's
required `node-dist-smoke` step runs the emitted CLI and MCP entries under
node. See [release-checklist.md](release-checklist.md).

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

