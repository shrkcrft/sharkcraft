# SharkCraft — improvement ideas & feature requests (post-alpha.25)

This round comes out of sustained AI-agent use of `v0.1.0-alpha.25`. The theme: alpha.25 finished the false-signal cleanup that alpha.24 began in STDOUT — the verdict strings now say `not verified`, `degraded`, `0 rules evaluated`, `this is not a pass` — but the **exit codes** (plus a couple of fresh regressions) still lie, returning `0` over results the prose itself calls unverified. Everything below is project-agnostic. The a23 bar for net-new (non-native) capability still applies; correctness / false-signal bugs are exempt from it.

## 0. What alpha.25 shipped & what's still open

Read this before re-specifying anything — it reconciles the last round against what actually landed.

**(A) Landed in alpha.25 — do not re-do, do not regress:**
- `check wiring --changed-only` no longer paints green over zero evaluated rules — it now prints an explicit `! 0 rules evaluated — NOT verified … this is not a pass` (verdict text fixed; **exit code still `0`** — see §1).
- `registry exists --fail-if-taken` (taken→`1` / free→`0`) and `--fail-if-missing` (inverse) now give correct complementary exit codes for guard scripting.
- `gen --typecheck` is a genuine **pre-write** gate: it compiles the virtual emitted files against the detected tsconfig and refuses a non-compiling write (`written=0`, exit `1`, nothing on disk). **This is the exit-code contract the rest of the CLI should copy.**
- `gen --print` now shows full rendered file bodies (closes the size-only preview gap).
- `task` / `context` render the full body by default, with `--summary` / `--brief` as opt-in terse (no second fetch, no hollow headers).
- `reuse` applies a confidence floor (weak keyword collisions no longer surface a confidently-wrong top hit) and reports the consumer total.
- `smart-context --task` now **fails loud** (degraded-model banner) instead of silently returning a stale guide dump.
- The prior references-shape Fatal (`Cannot read properties of undefined (reading 'outcome')`) is eliminated — both the knowledge-lint and stale-check paths run to completion.
- `doctor` pack-health is green; `changelog [--since <v>] [--json]` works as a version-delta self-discovery surface.

**(B) Partial / regressed — the work for this round:**
- Exit-code honesty: the fixed verdict text still returns `0` on unverified runs → **§1**.
- Two new false-signal regressions surfaced → **§2**.
- Stale-baseline gate, inert type-only exclusion, inert `--resolve`, and the bare-lifecycle hang → **§2 / §3**.

**(C) Still open from prior rounds → §4.**

**Load-bearing wins — do not regress:** the `gen --typecheck` pre-write gate · registry guard-mode exit codes · full-by-default orientation · the honest `not-verified` verdict text.

## 1. Exit-code honesty (P0)

alpha.24 and alpha.25 were labeling rounds: commands that used to print an unearned green now tell the truth in STDOUT — `not verified`, `degraded`, `0 rules evaluated`, `this is not a pass`. That fix is real and load-bearing. But it stopped at the text. **The exit code still returns `0` on every one of those honest-but-unverified paths** (or short-circuits to `0` before doing any work). So the false-signal class did not get eliminated — it *moved*, from the STDOUT an agent reads to the exit code an agent scripts on. An agent almost never parses the banner; it chains `shrk <cmd> && <next>`, and a `0` over a "not verified" result marches straight past the unverified gate. An honest string behind a lying exit code is arguably worse than a plain false green, because the honesty now lives on the channel nobody automates against. This section is the unifying contract for the whole round; §2/§3 are the per-command instances.

### 1.1 Adopt one exit-code contract across every gate/verify verb (P0 · Effort: M)

- **Problem.** There is no consistent, documented meaning for a shrk exit code. Today `0` conflates three outcomes an agent must tell apart: *verified pass* (checks ran, passed), *real failure* (checks ran, failed), and *indeterminate* (could not verify — empty scope, degraded fallback, short-circuit). Only the middle case is reliably nonzero; the first and third both return `0`, which is exactly the collapse that lets `cmd && next` proceed over an unverified result.
- **Why shrk uniquely.** Every other false-signal fix in this doc is a special case of this one. shrk's whole value proposition to an agent is *a gate it can chain* — and that contract IS the exit code. A gate that cannot signal "I did not check anything" through its exit status cannot be safely scripted, no matter how honest its prose. Native tools don't have this problem because they don't pose as verifiers; shrk does, so it owns the obligation.
- **Proposal.** One contract, enforced across every gate / verify / check verb:
  - `0` = **verified pass** — checks ran over a non-empty scope and passed. Never returned when zero units were evaluated.
  - nonzero (`1`) = **real failure** — checks ran and found violations.
  - a **distinct code (`2`) = not-verified / indeterminate** — empty evaluation scope, degraded fallback, short-circuit, or "refused to run." Distinct from both pass and fail so a chain can branch on it (`|| handle-indeterminate`).
  - a global **`--strict`** flag that promotes `2 → nonzero`, so an agent can opt into "treat unverified as failure" for a hard CI gate with one switch.
  - The model **already exists in the tool**: the `gen --typecheck` mode refuses and exits `1` rather than emit an unverified artifact. That refuse-to-nonzero posture is the correct instinct; this generalizes it from one verb to the whole gate surface, adding the third code so "unverified" is distinguishable from "broken."
- **Commands whose exit code currently lies** (each is a one-line instance; specs in §2/§3):
  1. The **diff-scoped wiring gate** returns `0` when the change intersects no rule scope — a green exit over zero evaluated rules, indistinguishable from a real verified pass.
  2. The **empty-scope lifecycle/registry check** short-circuits to `0` when its changed-scope is empty, reporting "nothing to verify" as success.
  3. The **degraded orientation/context fallback** returns `0` after announcing it fell back to a reduced-fidelity path — "degraded" in prose, "pass" in exit status.
- **Effort.** The taxonomy + `--strict` plumbing is the M; each call-site is an S once the shared verdict→exit mapper exists.

## 2. Regressions & fixes that did not land (P0/P1)

The two lead items are false-signal regressions — alpha.25 introduced or left in place a command that lies (an unearned green, a crash on a routine path). They are P0 regardless of native-tool overlap: an agent scripts on the exit code and proceeds on the lie. The remaining three are fixes that were **labelled as shipped but are inert or unbounded** — a documented flag with zero observable effect, or a stated budget the code doesn't honor. A promised-but-dead fix is its own trust trap: the agent reads the flag/banner as a guarantee. Ordered most-dangerous first.

### 2.1 A graph/query verb silently SWALLOWS unknown flags — a typo'd flag reads as confident success (P0 · Effort: S)

- **Symptom.** The cycle-query verb (and, by inference, its siblings in the same graph/query namespace) accepts an unrecognized/misspelled flag with **no diagnostic**: an unknown flag yields byte-identical output to the bare command and exits `0`. There is no `unknown option` error, no nonzero exit, no "ignored flag" warning.
- **Why it matters.** This is itself a false-signal bug — the exact class the prior round was about. A stale, renamed, or mistyped flag reads as *confident success*: the agent believes it invoked a narrowing/opt-in mode, sees plausible output + exit `0`, and concludes the mode ran. It poisons every "did the opt-in take effect?" verification — and in this run it is **precisely why the type-only opt-in (§2.3) could not be verified**: an opt-in flag and an outright garbage flag are indistinguishable, so nothing proves any flag on this verb is live. An arg parser that ignores unknown flags cannot be trusted to honor known ones.
- **Fix.** Reject unknown flags at the parser level for the whole graph/query family: emit `unknown option '<flag>'` to stderr and exit nonzero (standard strict-mode behavior). At minimum, echo the *effective* parsed flag set into the output / `--json` header so an agent can confirm a flag was recognized. Audit every verb sharing this parser — the swallow is almost certainly parser-wide, not verb-local.
- **Repro (shape).** `<query-verb> --no-such-flag` → output byte-identical to `<query-verb>`, exit `0`, nothing on stderr; a real-but-typo'd flag is likewise indistinguishable from a nonexistent one.

### 2.2 A registry `list` verb crashes `EPIPE` when its output is piped (P0 · Effort: S)

- **Symptom.** Piping a registry `list` command into a downstream consumer (`| head`, `| grep`, any early-closing reader) prints the truncated list, then throws an **unhandled `write EPIPE`** from the shutdown path and exits nonzero. Redirecting the same command to a file is clean. The list content is correct — the crash is purely the broken-pipe write on `stdout`.
- **Why it matters.** Agents pipe `list` output *routinely* (`| head` to sample, `| grep` to filter) — one of the most common shapes for a large enumeration. An unhandled `EPIPE` there poisons exit-code scripting: the agent sees a nonzero exit + an `Error:` line and concludes the *query* failed or the registry is broken, when the data was fine and only the pipe closed early. It converts a benign downstream close into a false failure on the happy path.
- **Fix.** Handle `EPIPE` on `stdout` / `stderr` as a normal early-close: swallow it (or `process.exit(0)` on the `EPIPE` error event) instead of letting it propagate out of the shutdown routine. Register an `stdout.on('error')` handler at startup so *every* verb that streams a list is covered — a global output-lifecycle fix, not a per-command patch.
- **Repro (shape).** `<registry-list-verb> | head` → truncated list, then `Error: write EPIPE … at cleanShutdown(...)`, nonzero exit. Same command redirected to a file → clean, exit `0`.

### 2.3 The type-only cycle exclusion is INERT — default equals the include-type-edges opt-in (P1 · Effort: M)

- **Symptom.** The claimed default behavior — excluding type-only (interface-to-interface / declaration-only) edges from the cycle count — has **zero observable effect**. The bare cycle query and the explicit include-type-edges opt-in report an **identical total and byte-identical member list**, and pure interface-to-interface cycles are still counted in the default view. The default and the opt-in are indistinguishable.
- **Why it matters.** This was the promised fix for phantom type-only cycles inflating the architecture/composite gate red. If the exclusion is inert, that inflation persists *and* the agent is told (by the flag's existence + the changelog) it was fixed — so it trusts a cycle count that still counts compile-time-only loops as runtime circular deps. A stated-but-dead default launders a known-bad number as a corrected one. (Verification is blocked by §2.1: because the opt-in flag is swallowed, "default == opt-in" can't distinguish "exclusion is inert" from "the flag never parsed." Fixing §2.1 is a prerequisite to even proving this.)
- **Fix.** Confirm the type-edge classifier actually runs in the default path (it appears short-circuited, or the exclusion set is empty). Type edges (`import type`, declaration-only references, interface-union members) must be dropped from the default walk, and the opt-in must *re-add* them and produce a **strictly larger-or-equal** count — the two views must diverge on any tree containing a pure type-only loop. Add a fixture with a known interface-to-interface cycle and assert default-count < opt-in-count.
- **Repro (shape).** `<cycle-verb>` and `<cycle-verb> --include-type-edges` report the same total and identical members, including pure interface-to-interface chains — no divergence.

### 2.4 Registry `exists --resolve` is INERT — ship an alias config schema or drop the flag (P1 · Effort: M)

- **Symptom.** The `--resolve` flag on the registry `exists` verb — documented to map a human/synonym noun to its canonical registered id before the existence check — has **no effect**. A human noun still returns `not declared` / exit `1` even when a canonical id for that noun exists; `--resolve` output is identical to `exists` without it; no alias/synonym source is ever consulted.
- **Why it matters.** `--resolve` is the affordance that lets an agent ask about a construct in natural-noun terms without knowing the exact canonical id — the whole point is to bridge the vocabulary gap. If it silently no-ops, the agent gets a definitive `not declared` for something that *does* exist under its canonical id, and may recreate an existing construct. The root gap is that **shrk has no alias/synonym config seam for a pack to declare against** — so the flag can't do anything.
- **Fix.** Ship an **alias/synonym config schema** (a declared map, and/or a normalization step: strip/append the canonical suffix, case-fold, singularize) and wire `--resolve` to consult it before the lookup; on a resolved hit, report the mapping (`<noun> → <canonical-id> (declared)`). If shipping that schema isn't in scope this round, **remove the flag** — a documented, gracefully-exiting flag that does nothing is exactly the false-signal class this round is about.
- **Repro (shape).** `<registry-exists-verb> <human-noun> --resolve` → `not declared`, exit `1`, even though a canonical `<noun>-<suffix>` id is declared; output identical to the same command without `--resolve`.

### 2.5 The bare full-scope lifecycle check HANGS past its own stated wall-clock budget (P1 · Effort: M)

- **Symptom.** The registry-lifecycle check advertises a "bounded by a wall-clock budget" banner, but only the diff-scoped variant is actually bounded (returns sub-second by short-circuiting an empty scope). The **bare full-repo scan does not honor the budget**: it prints only the `Scanning… (bounded by a wall-clock budget)` banner and never returns, running past the stated budget until externally killed. The fix is partial — the budget holds on the narrow path and is absent on the path that most needs it.
- **Why it matters.** The full-scope run is exactly the invocation an agent reaches for when it *hasn't* got a diff to scope by (fresh checkout, whole-tree audit) — and it's the one that eats the entire turn with nothing to show. A hang is the most expensive false signal because the agent can't even tell success from failure. Worse, the reassuring banner claims a bound the code doesn't enforce, so the agent won't add its own timeout.
- **Fix.** Make the wall-clock budget a real deadline on the full-scope path: enforce it in the scan loop (check elapsed per node/batch), and on expiry return a **partial result with a loud `budget exceeded — partial / not-verified` verdict and a nonzero-or-`2` exit** (per §1), never an open-ended hang. Do not print the "bounded" banner on a path where the bound isn't wired. Add a large-fixture test asserting the bare command returns within the advertised budget + margin.
- **Repro (shape).** Bare `<registry-lifecycle-verb>` → prints only the "Scanning… (bounded by a wall-clock budget)" banner, then runs past the stated budget until killed; the `--changed-only` variant on an empty scope returns sub-second.

## 3. Partial landings — finish the job (P1)

These landed *honest* but not yet *trustworthy* — the false green is gone, but the replacement is hollow, noisy, or non-actionable.

### 3.1 The composite gate goes false-RED on drift-vs-a-stale-baseline, not diff-vs-HEAD (P1 · Effort: M)

- **Symptom.** The composite quality gate correctly demoted baseline debt / cycle / impact counts to *non-blocking* (informational) — but it still exits `1` on `N NEW architecture error(s) since baseline`, where "since baseline" means drift against a **frozen, months-old snapshot**, not the current change. The "new" errors map to pre-existing structural issues in files the working diff never touched.
- **Why it matters.** A gate that RED-fails on debt the changeset didn't introduce trains the agent to ignore the gate — the exact trust regression the non-blocking demotion was meant to fix. "NEW" must mean *change-introduced*, or the verdict is noise.
- **Fix (engine).** Redefine "NEW" as **diff-vs-HEAD attribution**: intersect the error set with the files/symbols the changeset actually touches, so an error in an untouched file can never be counted as introduced. Keep the frozen-baseline delta available but *informational*, mirroring the debt line. (A deliberate **baseline re-freeze** verb, e.g. `gate baseline --refreeze`, is a reasonable operational complement — call it out, but it is not the engine fix and must not substitute for change-scoped attribution.)
- **Repro (shape).** `gate` → `FAIL`, `fail=1`, exit `1`; the sole FAIL line is `N NEW arch errors since baseline (baseline debt: M, informational)`; the N "new" errors resolve to pre-existing structures in files absent from the diff.

### 3.2 The diff-scoped wiring gate is honest but not yet trustworthy — no proof it selects footprint-relevant rules (P1 · Effort: M)

- **Problem.** `check wiring --changed-only` is now *honest* (it says **not-verified / skipped** when nothing is in scope instead of a false green — good, the a23 asks landed). But its behavior is still indistinguishable from plain changed-**file** scoping: there is no positive evidence it RUNS the rule a genuine cross-file / cross-layer change *should* trigger via rule footprint, and no flag to force that path. (Separately: `check wiring --help` is swallowed — it ignores the flag and runs the bare command.)
- **Why it matters.** The whole value of diff-scoping is running the *right* rules for a change's blast radius, not just the rules whose literal files were edited — a wiring bug is usually introduced in file A and *manifested* by a registration array in file B. Without demonstrable footprint selection, the gate is honest-but-hollow.
- **Fix.** (a, engine) Add a **`--base <ref>`** (and/or `--footprint`) flag that expands scope from changed files to the rules those files *participate in* (declared or registered side), then runs exactly those; ship a positive-control fixture proving a cross-file change fires its rule while an unrelated change does not. (b, CLI-UX) Fix `--help` swallowing so the verb documents its own scoping flags rather than executing.
- **Repro (shape).** With no in-scope diff, `--changed-only` skips all rules (correct) but output is byte-identical to changed-FILE scoping — no rule is shown as selected-by-footprint, and there is no flag to force one. `check wiring --help` prints the bare run, not usage.

### 3.3 `reuse` weak-intent stopped being confidently-wrong but now dumps the whole catalog (P1 · Effort: S)

- **Problem.** `reuse "<intent>"` no longer returns a confidently-wrong nearest hit on a weak/nonsense intent (good — the a23 failure mode is gone). But the replacement is a **full alphabetized dump of every declared candidate** — dozens of lines — with no ranking and no similarity score. An agent asking for a primitive gets a wall to re-read instead of the nearest 2-3.
- **Why it matters.** "No match, here's everything" costs as many tokens as the confidently-wrong answer and gives less signal — the agent still has to do the matching the tool was supposed to do. A scored top-K is the whole point of a reuse surface.
- **Fix.** Emit a **scored did-you-mean**: rank candidates by similarity, return the **top-K** (default 3–5) with the **score exposed** per row, and fall back to the full catalog only behind an explicit `--all` (or when every score is below a floor, stated as such). Same scoring the matcher already computes internally — surface it and cap the list.
- **Repro (shape).** `reuse "<nonsense intent>"` → `No primitive matched.` then the ENTIRE declared catalog (dozens of lines), no score column, no ranked suggestions.

### 3.4 Compress fidelity is in `--json` but the human text path has no lossy banner (P1 · Effort: S)

- **Problem.** The fidelity signal is real and correct in `--json` (`fidelity:'lossy'`, `savedRatio`, `tokensAreEstimated`). But the **human text path** prints only a token-ratio line and no explicit **lossy** banner; lossless and passthrough (no-win) cases are equally **unlabeled** for fidelity. An agent reading the text output cannot see the output was lossy.
- **Why it matters.** The text path is what a human (and most agent invocations) actually read. A lossy transform that doesn't *say* it's lossy in its primary output is a silent-correctness trap — the agent may treat a lossy digest as faithful.
- **Fix.** Mirror the JSON fidelity field into the text path: a one-line **`fidelity: lossy`** (or `lossless` / `passthrough`) banner alongside the ratio line, and explicitly label the no-win passthrough case. One line; parity with `--json` is the bar.
- **Repro (shape).** `--json` → `fidelity:'lossy'`; the human path for the same input prints only `markdown: ~<a> -> ~<b> tokens (-X%, est.)` with no fidelity line; the no-win input prints an unlabeled passthrough hint.

### 3.5 The changes/area classifier flags the gap loudly but has no built-in area for config/non-lib paths (P1 · Effort: S)

- **Problem.** The `changes` summary now attributes some files by area and **loudly** flags the miss (`unknown = taxonomy gap — not a low-risk signal` — good, exactly the honesty asked for). But a large share of a typical changeset — the config / tooling / non-lib paths — still falls into `unknown` because the classifier ships **no built-in area** for those paths and there is no documented seam for a pack to declare them.
- **Why it matters.** A classifier that dumps a big slice of an ordinary diff into `unknown` isn't yet usable for risk attribution — the loud flag is correct, but it fires on *every* config-touching change, so it becomes background noise rather than signal.
- **Fix.** Ship a **built-in default area for recognized non-lib paths** (build / tooling / manifest / config path patterns → a `config` or `tooling` area), and/or a **documented taxonomy seam** so a pack can declare config-area globs. Reserve `unknown` (and its loud flag) for *genuinely* unclassifiable paths.
- **Repro (shape).** `changes` → a docs/known bucket plus an `unknown` bucket + the loud taxonomy-gap flag; the `unknown` files are all config / non-lib paths with no built-in area to catch them.

### 3.6 `gen` persists only byte counts in the saved plan — bodies live only behind `--print` (P1 · Effort: M)

- **Problem.** The `gen` scaffold flow writes a persisted plan `.json`, but each entry records only **`sizeBytes`** — the actual file **bodies** exist only in the transient `--print` output, not in the saved plan. A plan reviewed or applied later has no content to diff or verify against.
- **Why it matters.** The plan is the review artifact and the apply source of truth. A plan that stores only byte counts can't be reviewed for correctness, can't be diffed against HEAD, and can't be re-applied deterministically — the agent has to re-run `gen --print` and *trust* it matches.
- **Fix.** Embed the generated **bodies** (or, if size is a concern, a **content digest** per entry) in the saved plan so review and apply operate on the same content that was previewed.
- **Repro (shape).** `gen <template>` → the persisted plan `.json` records `sizeBytes` per entry and no body or digest; reviewing the plan later shows byte counts only.

## 4. Still open from a23 / a24 (pointers — not re-spec'd)

- **The a23 headline — a registration/DI graph as a first-class peer to the import graph** (wiring-chain / unprovided / orphans queries): the superset that would retire the regex wiring rules. Still untouched, and still the highest-leverage net-new bet — it clears the a23 non-native bar because native tooling has no equivalent.
- a23 §3.1 — wiring test / explain.
- a23 §3.3 — trace `<literal>`.
- a23 §4.2 — quality-scored pack metrics.
- The a24 "trustworthy diff-scoped wiring" and "change-scoped verdict" items are the **§3.2 / §3.1** partials above — tracked there, not here.

## 5. Priority summary

Ranked by agent value; effort in parens.

1. **§1 — One unified exit-code contract** (verified=`0` / failure=nonzero / not-verified=`2`, `--strict` promotes) — **P0 (M).** The spine of the round; §2.5, §3.1, §3.2's not-verified paths all resolve to it.
2. **§2.1 — Reject unknown flags across the graph/query family** — **P0 (S).** A swallowed flag reads as confident success and is why §2.3 can't be verified; cheap, high-leverage.
3. **§2.2 — Handle `EPIPE` on piped stdout globally** — **P0 (S).** Piping `list` is a routine agent path; the crash forges a false failure.
4. **§2.5 — Enforce the wall-clock budget on the full-scope scan** — **P1 (M).** A hang is the most expensive false signal; the advertised bound must be real.
5. **§2.3 — Make the type-only cycle exclusion actually run** — **P1 (M).** Unblocked by §2.1; stops laundering a known-bad count as corrected.
6. **§3.1 — Change-scoped `NEW` attribution (diff-vs-HEAD) for the composite gate** — **P1 (M).** Stops training the agent to ignore the gate.
7. **§3.2 — `--base` / `--footprint` rule-selection + fix `--help` swallow on the wiring gate** — **P1 (M).** Turns honest-but-hollow diff-scoping into trustworthy diff-scoping.
8. **§2.4 — Ship an alias/synonym config schema for `--resolve`, or drop the flag** — **P1 (M).**
9. **§3.6 — Persist file bodies / digests in the saved `gen` plan** — **P1 (M).**
10. **§3.3 — Scored top-K did-you-mean for `reuse`** — **P1 (S).**
11. **§3.4 — Mirror the compress fidelity banner into the human text path** — **P1 (S).**
12. **§3.5 — Built-in config/tooling area default (or documented taxonomy seam)** — **P1 (S).**
13. **§4 — The a23 registration/DI graph headline** — **(L).** The standing strategic bet; net-new, clears the a23 bar, and would retire the regex wiring rules wholesale.

The through-line: alpha.24 and alpha.25 moved every unearned green out of the prose an agent reads and into an honest string — but they left it sitting behind an exit code that still says `0`, on the one channel an agent actually automates against. Fixing that is not a new feature; it is finishing the fix already started, so a chained gate can finally distinguish "passed," "failed," and "never ran." **a24 made the text honest; a25 must make the exit code honest.**
