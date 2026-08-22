# `shrk gates` — the rule-authoring trust layer

Every rule engine in shrk is only as trustworthy as the author's ability to see
what a rule **actually matched**. The dominant real-world failure of a homegrown
gate is not a wrong rule — it is a **silent green**: a selector goes stale after
a directory move, matches zero files, and the gate passes forever while real
violations ship.

`shrk gates` is the answer. It spans every data-defined plane at once:

| Plane | Declared in | Checked by |
|---|---|---|
| `wiring` | `wiringRules[]` | [`shrk check wiring`](wiring.md) |
| `policy` | `policyRules[]` | [`shrk policy-lint`](policy-lint.md) |
| `registry` | `registries[]` | [`shrk registry <name> …`](registry-inventory.md) |
| `registration` | `registrationGraph[]` | `shrk wiring chain \| unprovided \| orphans` |
| `baseline` | `baselines[]` | [`shrk baseline check`](baseline-drift.md) |
| `generated` | `generatedArtifacts[]` | [`shrk generated check`](generated-drift.md) |

```bash
shrk gates list [--plane <p>]     # every rule, its severity, its empty-match policy
shrk gates coverage [--strict]    # what each rule MATCHED — the stale-selector detector
shrk gates explain <id>           # the concrete inputs one rule resolved
```

## The loud-skip contract

A rule that checked **nothing** is reported distinctly from a rule that
**passed**. That distinction is the whole point:

- A source selector matching **0 files**, or matching files but extracting
  **0 ids**, makes the rule `skipped`.
- `skipped` never counts toward a green. `shrk check wiring`, `shrk policy-lint`,
  `shrk baseline check`, `shrk generated check` and `shrk gates coverage` all
  return **`2` (not verified)** rather than `0` when nothing was evaluated.
- Setting **`failOnEmpty: true`** on a rule promotes its skip to a real
  **failure (`1`)**. Turn it on once a rule is known to have real subjects —
  from then on, the rule quietly dying is itself a build failure.
- The global `--strict` also promotes any `2` to `1`. See [exit codes](exit-codes.md).

**An empty *sink* is different.** If the source extracted ids but the registered
side extracted none, every declared token "fails" — that is a genuine failure and
stays one. It is almost always a stale sink glob, so the report says so
(`emptySink`) instead of listing N unexplained tokens.

> The spec this came from proposed a distinct exit code `3` for a loud skip.
> shrk already ships a documented `0`/`1`/`2` contract in which `2` means
> exactly "empty evaluation scope … or refused to run", so a zero-match maps to
> `2` and `failOnEmpty` maps to `1`. Adding a fourth code would fragment a
> contract an entire earlier round was spent making honest.

## `gates coverage` — the stale-selector detector

```
=== Gate-rule coverage ===
  rules              5
  matched nothing    0

  ✓ [wiring] mcp-tool-registered  —  281 ids across 185 file(s)
      e.g. alignCacheTool, checkBoundariesTool, checkExternalPlanTool, …
  ✓ [policy] no-lazy-node-require  —  1652 content units across 1652 file(s)
  ✓ [baseline] mcp-tool-surface  —  283 entries across 1 file(s)
  ✓ [generated] json-schemas  —  37 generated files across 37 file(s)

Every rule is connected to something. ✓
```

Wire it into CI next to the gates themselves. A rule going stale then breaks the
build the day it happens rather than the day someone notices.

One rule kind cannot be inspected without side effects: a **`command`-compute
baseline**. It is reported as *not inspected* — never as `empty` — so the report
never claims a fact it did not check. Run `shrk baseline explain --id X` to
execute it on purpose.

## Rule self-tests

A rule can declare what it *should* match, so it is tested like code rather than
trusted like config. `gates coverage` evaluates the expectations and fails when
one breaks:

```ts
{
  id: 'mcp-tool-registered',
  // …
  selfTest: {
    expectMatchesAtLeast: 200,               // a floor on the match count
    expectIds: ['checkBoundariesTool'],      // positive fixture — must be extracted
    expectNotIds: ['simulateWorkflowTool'],  // negative fixture — must not be
  },
}
```

A negative fixture is what keeps an `exclude` honest: if the exclusion stops
working, `expectNotIds` catches it.

## `gates explain` — the universal introspection

`explain` dispatches to the plane-specific explainer, so one verb answers "what
does this rule see?" for any rule:

```bash
shrk gates explain mcp-tool-registered   # → wiring: both sets, each site, the diff
shrk gates explain no-lazy-node-require  # → policy: hits AND the hits an exemption dropped
shrk gates explain mcp-tools             # → registry: every id with its sites
shrk gates explain mcp-tool-surface      # → baseline: what it computes vs what is committed
```

An id may legitimately exist on two planes; `--plane <p>` disambiguates instead
of the tool guessing.

## Not `shrk gate`

`shrk gate` (singular) **runs** the quality-gate pipeline. `shrk gates` (plural)
**inspects the data-defined rules themselves**. Different verbs, different jobs.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every rule matched something and met its expectations. |
| `1` | A rule is misconfigured, broke a `selfTest`, or matched nothing while setting `failOnEmpty`. |
| `2` | A rule matched nothing (not verified), or no rules are declared. |
