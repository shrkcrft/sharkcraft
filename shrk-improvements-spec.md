# SharkCraft (`shrk`) — improvement spec, from real alpha.28 use

> Project-agnostic. Every item below was surfaced by running the shipped rule engines
> (`check wiring`, `registry`, `baseline`, `gates explain`) against a real codebase and
> exercising positive **and** negative paths. Each entry states **exactly what to change
> and how**. No consuming-project specifics. Priorities: P1 = correctness / core-promise,
> P2 = consistency & agent/CI surface, P3 = nice-to-have.

Generic example used throughout: a rule that asserts every `*_HANDLER` const declared in
`src/handlers/*.ts` is a member of the `HANDLERS` array in `src/registry.ts`.

---

## A. Correctness bugs (fix first)

### A1 · `shrk help <a> <b>` fails on every multi-word verb — **P1**
**Observed.** `shrk help check wiring` and `shrk help baseline check` both print
`Unknown command: check wiring`. Single-word help works; multi-token verbs don't.
**Why it matters.** `help <verb>` is the first thing anyone types on a new command family;
failing it makes the entire wiring/baseline/generated surface feel undocumented.
**Fix.** Route `help` through the **same longest-match command-path resolver** the main
dispatcher uses, over *all* trailing args joined — not `argv[1]` as a single token. If the
path doesn't resolve, print the nearest registered path as a suggestion. (One-line change in
the help router: resolve `args.slice(1)` against the command tree instead of `args[1]`.)

### A2 · `baseline explain` shows `0 now` before the first bless — **P1**
**Observed.** With no committed artifact yet, `shrk baseline explain --id X` printed
`entries 0 committed → 0 now`. After `baseline update` the same command correctly printed
`89 committed → 89 now`. The extractor yields the live set regardless of whether an artifact
exists, so `0 now` is simply wrong.
**Why it matters.** `explain` is the "what *would* this compute, without judging it" verb.
Its whole job is to show what `update` will write **before** you bless — the one moment it
currently reports `0`.
**Fix.** In the `baseline explain` path, **always run the compute** for the `now` side; only
the `committed` side may legitimately be absent. Render the empty-committed case as
`committed (none yet) → N now`, never fold `now` to `0`.

---

## B. Ergonomics & consistency (P2)

### B1 · `registry` argument order is verb-last and inconsistent with its siblings — **P2**
**Observed.** `shrk registry list <name>` fails with `No registry named "list"`; the grammar
is `registry <name> <verb>`. But `baseline`/`generated` read verb-first
(`baseline check [--id]`), so the instinctive `registry list <name>` is wrong. The error is
*helpful* (it lists the real registries) but doesn't guide to the right form.
**Fix (do both).**
1. **Accept both orders.** If arg1 isn't a known registry but arg2 is, swap them. Zero-risk,
   removes the stumble entirely.
2. **Suggest.** When arg1 matches a known *verb* (`list|exists|where|duplicates`), print
   `did you mean 'registry <name> <verb>'?`.

### B2 · The pipe-exit-code note is emitted unconditionally → noise — **P2**
**Observed.** Every piped run appends
`note: stdout is piped — $? reflects the downstream command…`. The intent is excellent (it
warns about the classic `cmd | tail` exit-code mask), but it prints on **passing** runs too
and lands inside `2>&1`-captured logs.
**Fix.**
- Emit it to **stderr only**, and **only when shrk's own verdict is non-zero** (a passing
  piped run needs no warning).
- Gate repeat noise behind a one-time-per-TTY hint and a `--no-hints` flag.
- Keep `--exit-trailer` as the structured opt-in and document it next to the note.

---

## C. Cross-plane uniformity — hardening the core promise (P1/P2)

### C1 · Guarantee **loud-skip on zero-match** in *every* plane — **P1**
**Observed.** `baseline` documents the skip / exit-2 / `failOnEmpty` contract clearly and
honors it. I could **not** confirm the same for `wiring` / `registry` / `policy`. This is a
latent correctness hole: a wiring rule whose `declared` glob goes stale extracts **0**
symbols, and `declared ⊆ registered` is **vacuously true** for an empty set — so the rule
passes green while enforcing nothing. That is exactly the silent-no-op the engine exists to
prevent.
**Fix.** Lift the `skipped` status and `failOnEmpty` (default **on** for `error`-severity
rules) into the **shared rule-runner**, so every plane behaves identically:
- a rule whose *produced* set OR every *consumed* selector is empty → `skipped`, not `passed`;
- `skipped` is a distinct status in text and JSON output;
- `failOnEmpty` turns `skipped` into exit-1.
Add a `rules coverage` (or fold into `gates coverage`) that lists every rule with its match
counts and **flags every rule that matched 0** — the stale-glob detector, run in CI.

### C2 · One exit-code contract for all gate verbs — **P2**
**Observed.** `baseline` uses `0/1/2` (2 = nothing evaluated); `check wiring` uses `0/1`.
CI wiring is simpler when every gate agrees.
**Fix.** Adopt one contract everywhere: `0` clean · `1` violations · `2` nothing
evaluated / all skipped · `3` config/usage error. Document it once; apply via the shared
runner from C1.

---

## D. Machine / agent interface (P2 — high leverage)

### D1 · Uniform `--json` on every gate verb, one envelope
**Gap.** Output is human text; CI and agents want a stable machine format, and I couldn't
confirm a uniform `--json` across the new verbs.
**Fix.** Every gate verb (`check wiring`, `registry *`, `policy check`, `baseline check`,
`generated check`) emits `--json` with a **shared envelope**:
```jsonc
{
  "verb": "check wiring",
  "exit": 1,
  "rules": [{
    "id": "handlers-registered",
    "type": "wiring",
    "status": "failed",              // passed | failed | skipped
    "severity": "error",
    "counts": { "declared": 90, "registered": 89 },
    "violations": [{ "id": "NEW_HANDLER", "file": "src/handlers/new.ts", "line": 2, "hint": "…" }]
  }]
}
```
`explain --json` emits the same per-rule shape plus the full extracted sites. One schema
across planes so a CI step / agent parses once.

### D2 · Unify `explain` into a single entrypoint
**Observed.** `explain` is fragmented across planes — `gates explain <id>` (worked for a
wiring id), `baseline explain --id`, `generated explain`, `policy-lint explain`. A user
holding a rule id has to already know which plane owns it.
**Fix.** `shrk explain <ruleId>` resolves the id across **all** planes and dispatches to the
right explainer. Keep the per-plane forms as aliases. This is the universal introspection the
trust layer is supposed to provide.

---

## E. Optional — deterministic autofix (P3, guard heavily)

### E1 · `shrk check wiring --fix` for the mechanically-unambiguous case
**Rationale.** Wiring/policy rules already carry a `hint`/`suggest`. For a
declared-but-not-registered violation with a **single** registered array, the fix is
deterministic: append the missing id to that array (+ add the import). A type-checker and an
agent don't give this as a guaranteed, reviewable edit — a deterministic tool can.
**Fix.** Opt-in `--fix` (dry-run by default, writes behind `--write`) that applies **only**
edits where the target array and insertion point are unique. Anything ambiguous (N candidate
sinks, no clear array) is left untouched and reported. Never guess.

---

## Verified working — do NOT regress

Concrete strengths observed; keep them as-is:
- **`gates explain <id>` prints the actual extracted set** (every declared site with
  file:line, `declared N / registered M`). This is the single most valuable feature — it lets
  a user *see* a rule matched N and didn't silently no-op. Preserve it across the D2 unification.
- **Two-way baseline drift** reports precisely: `DRIFT — 1 added, 0 removed (89 → 90,
  element-set)` naming the exact entry, with the bless hint. `update` as a separate explicit
  verb is the right design.
- **Negative-path messages** are actionable everywhere: what's missing, its file:line, and how
  to fix. `registry duplicates` names every colliding site.
- **Pipe detection** (the *intent* of B2) is a genuinely thoughtful guard — keep the detection,
  just change the dosage.
- **The docs** (`baseline-drift.md`, `extraction-dsl.md`) are precise and honest about
  trade-offs. Hold this bar for `wiring` / `registry` / `policy`.

## Suggested order
1. **C1** (loud-skip everywhere) — closes the one real correctness hole.
2. **A1 + A2** — two cheap, high-visibility bug fixes.
3. **D1 + D2** — the agent/CI surface; unlocks reliable automation.
4. **B1 + B2 + C2** — polish and consistency.
5. **E1** — only after the above, and only for the unambiguous case.
