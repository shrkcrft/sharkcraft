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
  from then on, the rule quietly dying is itself a build failure. Every plane
  accepts it — including `registries[]` and `registrationGraph[]` (round 11),
  which default to `false` because they carry no severity of their own.
- **An empty result can be the intended one** (round 13, see
  [intended-empty.md](intended-empty.md)). A rule whose primary selector matched
  no file because every inclusion unit is marked `{ pattern, expectEmpty: true }`
  is ACCEPTED — exit `0`, the acceptance printed — by the plane verb, `gates
  check` and `gates coverage` alike (one settle, `settleRuleEmptiness`). Files
  that matched but yielded **0 ids / tokens / content units** are never
  assertable: that is the stale-extractor loud skip. One advice sentence serves
  every verb: *Fix the selector — or, if its target does not exist yet, mark the
  unit `{ pattern, expectEmpty: true }`* — plus `failOnEmpty: true` only for a
  rule that does not already fail.
- The global `--strict` also promotes any `2` to `1`. See [exit codes](exit-codes.md).
- **A rule that passed over only PART of its scope is `partial`, not `passed`**
  (round 11). Every rule carries a `coverage` record — what it examined against
  what it was asked to — and the shared envelope turns a `passed` rule with a
  shortfall into `partial` and the run's exit into `2`. The classic case is a
  subset wiring rule whose registered side holds tokens its declared selector
  never produced: `declared ⊆ registered` passes by construction there, so the
  rule names them instead (`registeredExtras` accepts known extras explicitly —
  see [wiring](wiring.md#subset-coverage-and-registeredextras)). `gates check`,
  `gates coverage` and `gates explain` all read the same engine derivation.
- **"No rules declared" is `2` on every verb** — including `check wiring`,
  `policy-lint` and `gates check`, which used to exit `0`. `--allow-empty`
  accepts an empty request explicitly: exit `0`, with the acceptance printed.
- **A file over the 1MB read cap is expected, never silently dropped**
  (round 11). Every plane walks the tree through one reader. A glob-matched
  file it does not read (over the cap, or unreadable) is reported back, and
  the rule's coverage becomes `examined N of M files, K over the 1MB read cap:
  <path>`. So a forbidden token in a 1.7MB file is `partial` (`2`), never
  "examined 1 of 1 ✓". A rule whose only matched file is unread is `partial`
  too, never `failOnEmpty`'s `1`: it matched something it could not read. The
  same record reaches `policy-lint`, `check wiring`, `registry`, `baseline`,
  `generated`, `docs references`, `gates check | coverage`, `quality`,
  `finish` and `shrk gate`.
- **One scan scope.** Every plane walk, in a verb and in its aggregate, prunes
  the same directories: the SharkCraft asset/config dir when it sits inside
  the project (its `.ts` files hold the rule definitions, which would
  self-match). `check wiring` and `shrk gate` used to walk it while
  `policy-lint` and `gates check` pruned it, so one rule read `1` in one verb
  and `0 ✓` in the other.

**An empty *sink* is different.** If the source extracted ids but the registered
side extracted none, every declared token "fails" — that is a genuine failure and
stays one. It is almost always a stale sink glob, so the report says so
(`emptySink`) instead of listing N unexplained tokens. When the sink's file was
simply never read (over the read cap), the hint says that instead, so nobody
chases a glob that is fine.

> The spec this came from proposed a distinct exit code `3` for a loud skip.
> shrk already ships a documented `0`/`1`/`2` contract in which `2` means
> exactly "empty evaluation scope … or refused to run", so a zero-match maps to
> `2` and `failOnEmpty` maps to `1`. Adding a fourth code would fragment a
> contract an entire earlier round was spent making honest.

## Negation globs (round 12)

Every glob list a gate plane reads takes a leading `!` as an **exclusion**: an
extraction source's `files` (wiring, registry, registration, extractor
baselines, `extractors`, pack-contributed rules alike), an `import-edges`
`to.files`, policy `files`, a baseline's `watchFiles`, `generatedGlob` /
`sources[].glob` / `provenanceHeader.outsideGlob`, and doc-reference `files`.

```ts
declared: { files: ['src/**/*.ts', '!src/**/*.spec.ts'], extract: 'export-names', match: '_HANDLER$' }
```

- A path is selected iff one of the list's inclusion globs matches it and **none
  of its negations** does. Order-independent: a later glob never re-includes
  (this is not gitignore).
- A negation subtracts from **its own list only**. Planes walk the union of many
  rules' lists once, positively, and select per list afterwards, so one rule's
  `!x` never removes `x` from another rule's scope, and one side's `!` never
  hides a file another side of the same rule reads.
- One parser decides what `!` is (`parseGlobList`, `@shrkcrft/core`) and one
  test selects (`globListSelects`, `@shrkcrft/boundaries`). The boundary plane
  splits its `from` with the same parser, but there a `!` **exempts**: the file
  is still scanned and its violations are suppressed and counted (see
  [boundaries](boundaries.md#exemptions-and-exceptions)). On the gate planes it
  **excludes**: the file is out of scope.
- `--changed-only` reads the footprint per list: a changeset touching only files
  a rule excludes does not select it.
- An excluded file is out of scope for the read cap too: an over-cap file a `!`
  names never makes a rule `partial`.

**List shapes that fail at load.** A bare `!`, a double negation (`!!x` — write
the inclusion glob), and a list of negations only (it selects nothing) are
config errors naming the field, on every plane and at the pack-plane merge seam.
An exemption list (policy `exemptFiles`, generated `handMaintained`, boundary
`exemptFiles`) takes plain globs: a `!` there would read as "exempt everything
else", and is rejected.

**Liveness.** `gates coverage` judges a negation by what it EXCLUDES: it is
alive iff it removes at least one file from its own list's positive set, and
every live one is printed (`excludes: declared: !src/**/*.spec.ts (512 files)`;
`--json` per-rule `negations[]`). One that removes nothing is a dead glob — see
*Dead globs inside connected rules* below.

> **Upgrading.** Before round 12 every gate plane silently IGNORED a `!` entry:
> the files it named were measured all along, and deleting it changed nothing.
> Now it excludes as written, so an existing config may see:
> (a) findings in excluded files disappear — wiring declared ids, policy hits,
> registry duplicate sites, doc references, generated header findings;
> (b) an extractor baseline whose committed ledger holds ids from excluded files
> reports them LOST (two-way drift, exit `1`) — review with `shrk baseline diff`,
> then re-bless with `shrk baseline update`;
> (c) a wiring rule whose REGISTERED side partly lived in excluded files gains
> "not wired" violations;
> (d) a `selfTest` `expectIds` pinned to an id from an excluded file becomes a
> failed expectation;
> (e) a rule whose whole positive set is now excluded is `empty` (`2`, or `1`
> with `failOnEmpty`) — reported as `matched nothing after its own negations:
> every file its inclusion globs select is excluded (…)` with the negations
> that did it (`--json` `excludedByNegations`; the policy skip reason says the
> same), never as a stale selector;
> (f) under `--changed-only`, a changeset touching only excluded files no longer
> selects the rule;
> (g) a live negation is no longer reported as a dead glob.
> Each is the rule now measuring what its author wrote. There is no
> compatibility flag: delete the `!` entry to restore the old scope on purpose.

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

Every probed path (sorted) is a selfTest id on such a rule, so `expectIds` may
pin any watched file. A `selfTest` on a command baseline with **no**
`watchFiles` is a misconfiguration (`1`) — `selfTest.expectIds cannot be
evaluated: … add watchFiles` — never a permanently red "got 0": nothing can
produce that set without running the command.

### Dead globs inside connected rules — `--fail-on-dead-units`

A rule matching 0 is flagged. One level down used to be invisible: a rule whose
`files[]` lists `['src/handlers/*.ts', 'src/renamed-away/*.ts']` keeps matching
through the first glob after the second directory is renamed, so it reads
connected while half of it enforces nothing. Coverage judges every glob **per
unit** (through one decision, `globListUnits`, over the per-glob authority
`countMatchesPerGlob`) and names each dead one with its reason — prefixed with
its side when the rule reads more than one source:

```
  ⚠ [wiring] handlers-registered  —  2 ids across 2 file(s)
      ⚠ 1 of 3 glob(s) dead: declared: src/renamed-away/*.ts (matched 0 files)

Every rule is connected to something, but 1 glob(s) inside connected rules select or exclude nothing (⚠ above).
```

- **An inclusion glob is dead** when it selects nothing that survives its list's
  negations: `matched 0 files`, or `matches only files the list's negations
  exclude (N)`.
- **A negation is judged by what it EXCLUDES** (round 12), never by what it
  "matches": on its own it matches nothing; it subtracts. It is alive iff it
  removes at least one file from its own list's positive set (a matched but
  unread file counts), and every live one is printed as a plain line
  (`excludes: declared: !src/**/*.spec.ts (512 files)`), never a ⚠. One that
  removes nothing is dead: `excludes nothing — none of the N file(s) the other
  globs select match it` (the boundary plane's "exempts none of the N file(s)",
  in gate-plane words). So `--fail-on-dead-units` is usable in a repo whose rules
  exclude their tests: a load-bearing exclusion never fails it.
- **Checked:** every `files[]` glob of every extraction source (both wiring sides
  and every sink, chain hops, a registry's `source` and `consumer`, all three
  registration roles, an extractor baseline's source), an `import-edges`
  `to.files` (round 13: a target glob matching no file is dead — it used to be
  unchecked, so a typo'd fence target passed silently), a policy rule's own
  `files[]` (not a surface's default globs), a baseline's `watchFiles` (a glob
  that may match beneath a directory the walk could not list is not dead), a
  generated rule's `generatedGlob`, and a doc-reference rule's `files` (over the
  same dot-dir-aware walk the check reads). **Not checked:** a generated rule's
  `sources[].glob` (the writers partition the generated set — a file no writer
  owns is an `unclassified` finding), `outsideGlob`, and `handMaintained` (a
  bless naming no file is its own stale finding).
- **A unit marked `{ pattern, expectEmpty: true }` is never dead** (round 13,
  [intended-empty.md](intended-empty.md)). While it matches nothing it is
  intended-empty (`✓ asserted empty (expectEmpty): …`, its acceptance printed);
  once it matches it went live (`⚠ … expectEmpty is stale: …`, the ✓ withheld).
  Every unit is settled by the one core authority (`settleUnitLiveness`) over one
  observation predicate, so `gates coverage`, `gates try`, `quality` and every
  plane verb read one glob alike. `--fail-on-dead-units` fails an unmarked dead
  unit and a LOCAL went-live marker — never an intended-empty unit, and never a
  pack's marker (INFO: the consumer cannot edit it).
- **Advisory by default** — the exit is unchanged, but the clean line is never
  the unqualified "Every rule is connected". `--json` carries per-rule
  `deadGlobs` (the labels), `deadGlobUnits` (`{ selector, glob, negation,
  reason }`), `negations` (`{ selector, excludes }`), `excludedByNegations`
  (set only on a rule its own negations emptied — the primary list's live
  negations) and `globsChecked`, and a report-level `deadGlobCount`.
- **`shrk gates coverage --fail-on-dead-units`** fails the run (`1`); each
  violation's `message` is the unit's reason. The flag name is shared with the
  boundary plane, so one CI switch means one thing.
- **Connected rules only.** A rule already reported as matching nothing has no
  live sibling glob to hide behind. Its "matched nothing" verdict stands (`2`,
  or `1` with `failOnEmpty`). Its dead globs are not counted in
  `deadGlobCount`, drawn with a ⚠, noted by `shrk quality`, or failed by
  `--fail-on-dead-units`. So the flag never turns a soft-empty rule's `2` into
  a `1`. The per-rule `deadGlobs` in `--json` still lists them.

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

For the wider net before a push — these planes **plus** doctor, boundaries,
coverage, drift, the context/agent tests and the pack doctor — run
[`shrk quality`](quality-gates.md), which is exhaustive by default and prints
the isolated repro command for every failure. It carries `gates coverage` as an
item of its own (`gates-coverage`, settled by the same derivation the verb
uses), so a broken selfTest or a stale selector fails the before-you-push gate
too — dead globs ride along as advisory notes.

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
# an anchored pattern needs the m flag — exactly as `flags: 'm'` does in config
shrk gates try --wiring "declared=src/tools/*.ts:^export const (\w+Tool) registered=src/all.ts:(\w+Tool)" --flags m
```

> The inline `<glob>:<pattern>` split is on the **first** colon — a glob never
> contains one, and a pattern often does (`name: '(\w+)'`). `--flags <f>` applies
> to both inline patterns; a `--rule-file` spells `flags` per source, as config
> does (`--flags` with `--rule-file` is refused, not ignored). Your shell still
> sees the pattern before shrk does — reach for `--rule-file` for anything quoted.

**The dry-run is the enforcing engine.** A candidate compiles through the same
extractors, with the same regex flags, as the rule will once it is in config:
an anchored pattern yields one match set across `gates try`, `gates coverage` and
`registry <name> list` (locked by `r75-try-gate-parity.test.ts`). When a pattern
has a `^`/`$` anchor but no `m` flag, `try` adds a note — the anchor then
matches only at the start/end of the whole file, in config as much as here.

- The candidate is validated with the **loader's own schema**, and normalised by
  the same function the loader's rules go through, so severity, `failOnEmpty`
  and `selfTest` mean here what they will mean once pasted in.
- It may `$use` the project's [shared extractors](extraction-dsl.md#shared-extractors-use).
- **Its `selfTest` is evaluated** with the one evaluator `gates coverage` uses,
  and every expectation is printed (`held` / `FAILED` / `NOT EVALUABLE`; in
  `--json`, `selfTest.checks[]`). With none declared it says so, and points at
  `gates scaffold-selftest`.
- **Exit:** `1` when the selfTest fails or the candidate is misconfigured; `2`
  when it matched nothing or examined only part of its scope (it also says what
  `gates coverage` would exit once the rule is in config: `1` with
  `failOnEmpty`, else `2`); `0` otherwise. Violations do **not** fail the
  dry-run — finding them is the rule doing its job; they are listed under
  `would be: failed`. `--json` carries `exitCode` and the `settled` verdict.
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

Every plane accepts `selfTest` **and `failOnEmpty`** — including `registries[]`
and `registrationGraph[]`, which are inventories rather than gates. An inventory
whose selector went stale is arguably worse than a failing gate: it reports an
empty registry as *fact*, and nothing looks wrong.

A registration idiom is **empty** when its `declared` role (its primary
selector) extracts 0 tokens. `gates check` and `gates coverage` both read one
per-role measurement, so a `failOnEmpty` idiom fails in both or in neither.
Each role is a unit of the rule's coverage (`unit: 'roles'`, 3 expected). A
provided or consumed role whose globs match no file examined nothing, and
neither did a role that could not run. The rule is then `partial` (`2`) in both
verbs, never ✓. A provided role that reads live files and provides nothing is
different: that is the unprovided finding itself, not an unexamined role.

### What a selfTest asserts, plane by plane

Every field asserts on ONE thing — the rule's **extracted set**, what its
primary selector matched in the live tree. None is ranker-surfaced (the
order-sensitive class agent-contract tests have), so none flips on an unrelated
content edit. What is counted, and what an "id" is, differs per plane:

| Plane | `expectMatchesAtLeast` counts | an "id" (`expectIds` / `expectNotIds`) is |
|---|---|---|
| `wiring` | distinct declared tokens (`chain[0]` for a chain) | a declared token |
| `registry` | distinct source ids | a registry id |
| `registration` | distinct declared tokens | a declared token |
| `policy` | content units scanned (files, or inline-template bodies) | a pattern match — capture group 1, else the whole match — over findings **and** exempted hits; a hit the rule's own `scan` zone dropped does not count ([details](policy-lint.md#self-tests)) |
| `baseline` (extractor) | distinct entries | an entry |
| `baseline` (`command`) | `watchFiles` paths probed | a watched path — with no `watchFiles` the selfTest is **not evaluable** (a misconfiguration, `1`) |
| `generated` | generated files | a generated file path |
| `doc-reference` | doc-reference tokens checked | a validated token |

Every failure names the selector it consulted and the unit it counted:

```
! selfTest: expected at least 999 ids, got 290 — consulted: registry "mcp-tools" — source packages/mcp-server/src/tools/*.tool.ts (regex-capture)
! selfTest: expected id "nope" was NOT extracted — not among the 290 registry ids; consulted: registry "mcp-tools" — …
```

`--json` carries every expectation with its result under `rules[].selfTestChecks`
(`{ field, assertion: 'extracted-set', expected, status: held | failed |
not-evaluable, actual?, message }`); `expectationFailures` keeps the failed
ones' messages. `gates try` and `shrk quality` read the same evaluator
(`packages/cli/src/gates/self-test.ts`).

### `gates scaffold-selftest` — the fixture, written for you

The contract above is the step that gets skipped — not from disagreement, but
because authoring the fixture inline (which ids to pin, what floor to set) is a
blank page at the exact moment you just want the rule to work. And a rule with
no selfTest is invisible to the stale-glob detector, so the friction converts
directly into missing coverage.

```bash
shrk gates scaffold-selftest <ruleId> [--margin N] [--write]
```

It runs the rule against the live tree and emits a ready-to-commit block:

```
  selfTest: {
    expectMatchesAtLeast: 5,
    expectIds: ['ALPHA_HANDLER', 'BETA_HANDLER', 'DELTA_HANDLER'],
    expectNotIds: [],
  },
```

- **The floor sits below the current count** (`--margin`, default 20%). Pinning
  the exact number turns every legitimate addition into a failure, and a rule
  that cries wolf on normal work gets its expectations deleted rather than
  fixed. The assertion is "the selector still bites", not "the set never
  changes".
- **Anchors avoid names that were always going to churn** — `tmp*`, `*_test`,
  hash-like and counter-suffixed ids rank last. Selection is deterministic, so
  the same tree always scaffolds the same fixture.
- **It refuses to scaffold from a rule matching nothing.** A selfTest built on
  an empty set pins the broken state as correct — the very bug the fixture
  exists to catch.
- **On the policy plane it pins only exempted hits** (coverage's `pinIds`).
  Those are the fixtures an `exemptFiles` / `exemptLines` exemption keeps,
  which prove the pattern still bites. A live finding is debt. Pinning it
  would turn `gates coverage` red on the day the author fixes the code the rule
  forbids. With no exempted hit it scaffolds `expectIds: []` and a note saying
  to add an exempted fixture file.
- **It refuses to overwrite an existing selfTest**, and `--write` refuses when
  the id appears twice or comes from a pack rather than the local config. A
  write into the wrong rule silently re-points an assertion at a different set.

This is the one `gates` subverb that can write, and only under `--write`.

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
| `0` | Every rule ran over its WHOLE scope and passed — or a gap was explicitly accepted (`--allow-empty`, `registeredExtras`, a baseline fence's `expectEmpty: true`, a `{ pattern, expectEmpty: true }` unit — an intended-empty rule included), which is printed. A went-live marker withholds the ✓ but not the `0`. |
| `1` | A rule is misconfigured (a malformed pack marker included — an ERRORED row), broke a `selfTest` (or declares one its plane cannot evaluate), matched nothing while setting `failOnEmpty` (a fence over a dead input, a ceiling over an empty measurement included), or — under `gates coverage --fail-on-dead-units` — carries a dead glob (one that selects or excludes nothing) or a LOCAL marker that went live. |
| `2` | A rule matched nothing / was skipped (never "0 units out of live files" — that is not assertable), a rule passed over only PART of its scope (`partial`), or no rules are declared (unless `--allow-empty`). |
| `3` | Usage error — unknown subcommand, unknown `--plane`, unknown `--only` id, or an unrecognized flag. |

An unrecognized flag is **refused**, not ignored: a mistyped `--changed-only`
would otherwise parse as an unrelated `true`, run the *unscoped* command, and
return `0` — which reads as "the scoped check passed".
