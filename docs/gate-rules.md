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
| `doc-reference` | `docReferences[]` | [`shrk docs references check`](doc-references.md) |

```bash
shrk gates check [--changed-only]     # every plane's VIOLATION check — one exit code
shrk gates coverage [--changed-only]  # what each rule MATCHED — the stale-selector detector
shrk gates list [--plane <p>]         # every rule, its severity, its empty-match policy
shrk gates explain <id>               # the concrete inputs one rule resolved
shrk gates try --rule-file <f>        # dry-run a candidate rule WITHOUT touching config
```

**Three verbs, three questions.** `gates check` asks *are there violations*;
`gates coverage` asks *are the rules still connected to anything*; `shrk quality`
is the heavier pre-PR bundle (doctor + boundaries + tests). Conflating the first
two is how a repo ends up green on both counts while one of them checked
nothing.

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

### The `command`-baseline probe

`gates coverage` never runs a `command` compute — it has side effects, and the
trust layer must not cause any. That left one blind spot: a command baseline
whose inputs moved looked exactly like a healthy one.

Its `watchFiles` now doubles as a cheap **probe**. Coverage globs them (no
spawn) and reports:

```
✓ ledger  —  12 watchFiles input(s) (compute unverified — command never run)
✗ ledger  —  0 watchFiles input(s) …   ← the glob went stale
```

It never claims the compute is correct — only that its inputs still exist. A
command baseline with no `watchFiles` is still reported as *not inspected*, and
says so along with how to enable the probe.

## `gates check` — every plane, one exit code

Gating a change used to mean running `check wiring`, `policy-lint`, `baseline
check`, `generated check` and `registry … duplicates` separately and
`&&`-chaining five exit codes — so in practice people ran one or two.

```bash
shrk gates check                        # every declared rule, every plane
shrk gates check --strict               # zero-warning CI: warning findings block too
shrk gates check --changed-only         # only rules whose FOOTPRINT touches the diff
shrk gates check --since main           # …scoped to a ref instead of the working tree
shrk gates check --plane wiring,policy  # one or more planes
shrk gates check --only rule-a,rule-b   # named rules (an unknown id is refused)
shrk gates check --no-spawn             # skip the shell-executing halves
shrk gates check --json                 # the shared `gate` envelope (docs/gate-json.md)
```

It calls the **same evaluators** the per-plane verbs call, so the aggregate can
never disagree with the verb it stands in for.

### What each plane contributes

| Plane | Violation it checks |
|---|---|
| `wiring` | declared-but-not-registered tokens |
| `policy` | forbidden content in non-compiled artifacts |
| `registry` | ids declared in more than one place (load-order roulette) |
| `registration` | tokens declared/consumed but **provided by nothing** |
| `baseline` | the committed ledger drifted (both directions) |
| `generated` | a hand-edited generated file, or a missing provenance header |

### `--no-spawn`

Two planes execute shell commands: a `command` baseline compute, and a
generated `regen`. `--no-spawn` skips exactly those, keeping the pure-read halves
(the header contract, tree classification, extractor computes). A rule whose
drift half was skipped is reported **`skipped`, never `passed`** — a header
contract holding proves nothing about whether the file was hand-edited, so the
run exits `2`, not `0`.

### `--strict` — the zero-warning switch

A `warning`-severity rule reports without failing, which is the right default:
the registration plane's orphan check, for instance, fires on states that are
normal mid-refactor. Teams running a zero-warning CI promote them with
`--strict`:

```bash
shrk gates check --strict     # a warning-severity finding now exits 1
```

This reuses the established **local** meaning of `--strict` (`shrk check
--strict` already promotes warnings to failures) rather than introducing a
second severity model. It composes with the **global** `--strict`, which
promotes a not-verified `2` to `1` — so under `--strict` both a warning finding
and an unproven run block, and the banner says which.

### Scope vs. accident

`--changed-only` and `--since <ref>` narrow by rule **footprint** — a rule fires
when the diff touches *either* side of it, so a registration edited in file B
still fires a rule declared over file A. A rule with no resolvable footprint (a
`command` baseline with no `watchFiles`) cannot be proven out of scope, so it
stays **in**.

Two kinds of "did not run" are kept apart, because conflating them breaks the
surface either way:

- **Skipped by scope** — you asked for the narrowing, so it does not fail the
  run. A pre-commit hook must not exit non-zero on every commit.
- **Skipped by accident** — a selector matched nothing, or `--no-spawn` dropped
  the drift half. Nobody asked for that: exit `2`.

The banner always says which, and how many.

## The pre-commit pair

```bash
shrk gates check --changed-only && shrk gates coverage --changed-only
```

The first asks *did this change violate a rule*; the second asks *did this
change break a rule's selector*. Both scope to the diff, so they run on the
inner loop rather than only in CI — which is the point: a stale glob is caught
the moment you cause it, not the next morning.

`gates coverage` memoizes its tree reads for the duration of one call (N rules
sharing a glob cost one walk — worth ~25% on a wide scan). The memo never
outlives that call: a scan that answered "nothing drifted" from a stale read
would be worse than a slow one. `--no-cache` drops it.

## `gates try` — the rule-authoring REPL

`explain` only works once a rule is **in** the config, so tightening a selector
meant a round trip through the file every time. `gates try` runs the extraction
against the live tree and prints the resolved sets — writing nothing.

**`--rule-file` is the primary form.** It works on every plane, it survives any
regex, and it is the same JSON you paste into config:

```bash
shrk gates try --rule-file ./candidate.json [--plane <p>]
```

The plane is inferred from the rule's shape (`generatedGlob` → generated,
`compute` → baseline, `declared`+`provided`+`consumed` → registration, …); pass
`--plane` when a shape is ambiguous.

```bash
# the quick wiring convenience form
shrk gates try --wiring 'declared=src/handlers/*.ts:(\w+_HANDLER) \
                         registered=src/registry.ts:(\w+_HANDLER)'
```

> The inline form fights shell quoting as soon as a pattern contains spaces or
> regex metacharacters — the `<glob>:<pattern>` split is on the LAST colon, and
> your shell sees the pattern before shrk does. Use it for **single-token
> patterns**; reach for `--rule-file` for anything else.

- The candidate is validated with the **loader's own schema**, so a spec that
  passes here is a spec that will load.
- It may `$use` the project's [shared extractors](extraction-dsl.md#shared-extractors-use).
- A candidate whose selector matches nothing exits `2` — the REPL will not tell
  you a dead selector is fine.
- It **never spawns**: a `--rule-file` is arbitrary JSON, and honouring a `regen`
  or `compute.run` from it would turn a read-only preview into shell execution
  from an untrusted file.
- It covers **every plane** — wiring, policy, registry, registration, baseline,
  generated. The wiring plane additionally prints both resolved sets and the
  set-difference between them, reusing the same renderer as `gates explain`.

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
| `2` | A rule matched nothing / was skipped (not verified), or no rules are declared. |
| `3` | Usage error — unknown subcommand, unknown `--plane`, unknown `--only` id, or an unrecognized flag. |

An unrecognized flag is **refused**, not ignored: a mistyped `--changed-only`
would otherwise parse as an unrelated `true`, run the *unscoped* command, and
return `0` — which reads as "the scoped check passed".
