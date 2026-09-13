# The gate JSON envelope (`sharkcraft.gate/v1`)

Every gate verb has always supported `--json`, but each plane emitted its own
schema — `sharkcraft.wiring/v1`, `sharkcraft.policy-lint/v1`,
`sharkcraft.baseline/v1`, `sharkcraft.generated-drift/v1`,
`sharkcraft.gate-coverage/v1`. A CI step or an agent that wanted one answer
("which rules ran, which failed, and why?") had to parse five shapes.

Every gate verb now also emits a **shared envelope** under a `gate` key:

```bash
shrk check wiring     --json | jq .gate
shrk policy-lint      --json | jq .gate
shrk baseline check   --json | jq .gate
shrk generated check  --json | jq .gate
shrk gates coverage   --json | jq .gate
shrk check boundaries --json | jq .gate   # one `boundary` rule per selected rule (+ errored rows); run coverage in `rules`
shrk finish           --json | jq .gate   # one `finish` row per deciding sub-gate that evaluated something
shrk diff-check       --json | jq .gate   # `diff` rows for the boundaries and import-hygiene sub-checks
```

```jsonc
{
  "schema": "sharkcraft.gate/v1",
  "verb": "check wiring",
  "exit": 1,                     // the code the process actually returns — settled, never 0 over a shortfall
  "verdict": "fail",             // pass | fail | not-verified | usage-error  (`exit` in words)
  "evaluated": 2,
  "skipped": 1,
  "failed": 1,
  "partial": 1,
  "coverage": {                  // the RUN: what it examined against what it was asked to
    "unit": "wiring rules", "expected": 3, "examined": 2,
    "unexamined": ["stale-rule"], "reason": "checked nothing or could not run"
  },
  "shortfalls": [                // every gap that vetoes a clean verdict (rule gaps prefixed `<id>: `)
    "examined 2 of 3 wiring rules, 1 checked nothing or could not run: stale-rule",
    "tools-registered: examined 283 of 284 registered tokens, 1 registered with no declared site this selector produces: legacyTool",
    "stale-rule: 0 declared tokens to examine — 0 files matched the source globs"
  ],
  "accepted": [],                // gaps an explicit valve waived — printed, never silent
  "rules": [
    {
      "id": "handlers-registered",
      "type": "wiring",          // wiring | policy | registry | registration | baseline | generated | doc-reference
                                 //   (+ boundary | knowledge | lifecycle | orphans | finish | quality | diff | reuse)
      "status": "failed",        // passed | partial | failed | skipped | error
      "severity": "error",
      "counts": { "declared": 90, "registered": 89 },
      "coverage": { "unit": "declared tokens", "expected": 90, "examined": 90 },
      "violations": [
        { "id": "NEW_HANDLER", "file": "src/handlers/new.ts", "line": 2, "hint": "Add it to HANDLERS." }
      ]
    },
    {
      "id": "tools-registered",
      "type": "wiring",
      "status": "partial",       // passed in what it examined — and it did not examine everything
      "severity": "error",
      "counts": { "declared": 283, "registered": 284 },
      "coverage": {
        "unit": "registered tokens", "expected": 284, "examined": 283,
        "unexamined": ["legacyTool"], "unexaminedTotal": 1,
        "reason": "registered with no declared site this selector produces"
      },
      "shortfall": "examined 283 of 284 registered tokens, 1 registered with no declared site this selector produces: legacyTool",
      "violations": []
    },
    {
      "id": "stale-rule",
      "type": "wiring",
      "status": "skipped",
      "severity": "warning",
      "counts": { "declared": 0, "registered": 89 },
      "coverage": { "unit": "declared tokens", "expected": 0, "examined": 0, "reason": "0 files matched the source globs" },
      "shortfall": "0 declared tokens to examine — 0 files matched the source globs",
      "violations": [],
      "skipReason": "0 files matched the source globs"
    }
  ]
}
```

## Coverage is part of every verdict (round 11)

A clean verdict is a claim about a scope. Every rule — and the run — carries a
**required** `coverage` record, so "what did this examine, against what was it
asked to examine?" is answerable for every verdict, and one guard compares the
two:

- `examined === expected > 0` (not capped) → the scope was covered.
- `capped` → **never** clean, never acceptable: the remainder was never read.
- `expected === 0` → nothing to examine is not a pass (exit `2`) unless an
  explicit valve accepts it (`--allow-empty`).
- `examined < expected` → a shortfall, unless an explicit valve accepts it
  (`registeredExtras`, `expectEmpty`, a doc rule's own exemptions).

The guard lives **inside** `buildGateEnvelope`: a `passed` rule with a
shortfall becomes `partial`, and a proposed `0` settles to `2`. `1` and `3` are
never changed. So `gate.exit` can never be `0` while `shortfalls` is non-empty,
whichever verb built the envelope.

## It is additive, on purpose

The per-plane payloads are published, documented, and asserted by tests.
Replacing them would break every existing consumer, so the envelope rides
**alongside** them:

```jsonc
{
  "schema": "sharkcraft.wiring/v1",   // unchanged
  "rules": [ { "ruleId": "…" } ],     // unchanged, plane-specific shape
  "gate":  { "schema": "sharkcraft.gate/v1", … }   // new, identical across planes
}
```

`jq .gate` is the uniform read; everything that worked before still works.

## Field notes

| Field | Meaning |
|---|---|
| `exit` | The code the process returns — always consistent with the [exit-code contract](exit-codes.md). Read this instead of re-deriving a verdict from the rule list. |
| `status` | `skipped` is first-class, never folded into `passed`. A rule that matched nothing enforced nothing. |
| `counts` | Plane-appropriate match counts (`declared`/`registered`, `committed`/`current`, `units`/`findings`, …). Always present, so "what did this rule see?" is answerable uniformly. |
| `skipReason` | Present exactly when `status` is `skipped` — the sentence explaining what matched nothing. |
| `error` | Present when the rule is misconfigured (`status: "error"`). |
| `verdict` | `pass` / `fail` / `not-verified` / `usage-error` — `exit` in words. Gate CI on this. |
| `coverage` (run) | What the run examined against what it was asked to: `{ unit, expected, examined, capped?, unexamined?, unexaminedTotal?, root?, reason?, acceptedBy?, acceptedRatio? }`. Always present. |
| `rules[].coverage` | The same shape, per rule. **Required** — no producer can omit it. |
| `status: "partial"` | Derived by the envelope builder alone: a rule its plane reported `passed` whose coverage has a shortfall. Never a pass; the run's `exit` is then `2`. |
| `rules[].shortfall` / `shortfalls` | The gap sentence(s). `shortfalls` holds the run's and every rule's (prefixed `<id>: `); non-empty ⇒ `exit` is never `0`. |
| `accepted` | Gaps an explicit valve waived (`--allow-empty`, `registeredExtras`, `expectEmpty`, a doc rule's exemptions) — printed next to the green, never silent. Non-empty **only when `exit` is `0`**: an acceptance is what a clean verdict stands on, and over a `1`/`2`/`3` nothing was granted. |
| `rules[].unitAcceptance` | Round 13: the rule's `expectEmpty` acceptance — the selector units it asserts are intended-empty (`acceptedBy: "expectEmpty"`, labelled with what was observed). Folded into the ONE settle beside `rules[].coverage`, so it reaches `accepted` at exit `0` and is never dropped; it never changes `status`. When the rule itself is intended-empty it is the same record as `rules[].coverage` (printed once). Optional. |
| `rules[].units` | Round 13: `{ dead, intendedEmpty, wentLive }` — the rule's non-live selector units, one printed line each (`formatUnitLiveness`). `dead` holds UNMARKED dead units only. Optional; absent when every unit is live. |
| plane `verdict` (outside `gate`) | Each plane payload's own top-level `verdict` is derived from the settled exit (`planeVerdictForExit`): `pass` (or `warnings`) only at `0`, `errors` at `1`, `not-verified` at `2` — never `pass` next to `exitCode: 2`. |
| `partial` | How many rules are `partial`. |
| `evaluated` | Rules that ran a real comparison: status neither `skipped` nor `error` (`partial` counts). An errored rule proved nothing. A rule **accepted as intended-empty** (round 13 — its coverage IS its `expectEmpty` acceptance: every inclusion unit of its primary list marked, 0 files examined) ran no comparison either, so it is never counted here — see `acceptedEmpty`. |
| `acceptedEmpty` | Round 13: the rules accepted as intended-empty, counted apart from `evaluated` (the text prints `N evaluated, M accepted as intended-empty`). ONE predicate decides it for every verb — `ruleAcceptedAsIntendedEmpty` (`@shrkcrft/core`), over the record the rule's settle produced. A rule that examined live units beside a planned one (its acceptance rides as `rules[].unitAcceptance`) and the baselines rule-level fence (`acceptedBy: "expectEmpty: true"`) stay `evaluated`. OPTIONAL: present only when non-zero, so the envelope gains no always-present key. |
| `rules[].violations[]` under `gates coverage --fail-on-dead-units` | One per dead glob: `id` is the side-qualified glob, `message` its reason (`matched 0 files`, `matches only files the list's negations exclude (N)`, or `excludes nothing — none of the N file(s) the other globs select match it`) suffixed `(--fail-on-dead-units)`. A live negation is never one. |

## A CI step for every plane at once

`shrk gates check` emits the envelope for **every** plane in one run, so the
loop below is usually unnecessary — one command, one envelope, one exit code:

```bash
shrk gates check --json | jq -e '
  .gate as $g
  | if $g.verdict == "pass" then true
    else
      ($g.rules[] | select(.status=="failed" or .status=="error")
       | "FAIL \(.type)/\(.id): \(.violations | length) violation(s)"),
      ($g.shortfalls[] | "NOT VERIFIED: \(.)"),
      false
    end'
```

`verdict == "pass"` is the one condition to gate on: it is false for a
violation, a skipped rule, a `partial` rule and an empty scope alike — the
older `failed == 0 and skipped == 0` check passed a `partial` rule.

The per-plane verbs still emit the identical shape, so the same `jq` works
against any one of them:

```bash
for verb in "check wiring" "policy-lint" "baseline check" "generated check"; do
  shrk $verb --json | jq -e '.gate.verdict == "pass"'
done
```

`shrk knowledge stale-check` / `knowledge verify` (round 11) emit the same
envelope with ONE rule, `knowledge-references` (type `knowledge`): `counts`
`{entries, verified, stale, unverifiable, references, anchors}`, `violations`
for stale / missing references (and every unverifiable entry under
`--require-references`), status `skipped` with a `skipReason` when no entry in
scope declared anything checkable. The RUN coverage is entries examined of
entries in scope (`unit: "knowledge entries"`), so an unverifiable entry is a
shortfall — `gate.verdict` is `not-verified` unless `--min-referenced` accepted
it (then it appears in `accepted`). See [knowledge-integrity.md](knowledge-integrity.md).

See also [`shrk gates coverage`](gate-rules.md), which answers the complementary
question — are the rules still *connected* — across every plane in one command.
