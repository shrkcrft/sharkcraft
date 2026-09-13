# Intended-empty selectors (`expectEmpty`)

A rule that matches nothing is a bug in the rule, never a pass — that is the
loud-skip contract every gate plane keeps ([gate-rules.md](gate-rules.md)). But
some empty results are the *intended* ones: a fence written before the code it
fences, a scope glob for a package that is planned, a boost for a knowledge
entry that lands next sprint. Before round 13 the only way to reach a clean
verdict over such a configuration was to delete the correct thing.

`expectEmpty` is how you say so, **per unit**, on every list that can report a
dead or empty unit. A marked unit that matches nothing is accepted — and the
acceptance is always printed. A marked unit whose target appears is reported as
**went live**: the marker is stale, and `--fail-on-dead-units` fails on it.

```ts
forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }]
```

## The vocabulary

One entry form serves every markable list:

```ts
string | { pattern: string; expectEmpty: true; reason?: string }
```

- The unit is named in `pattern` on **every** list — glob lists and
  import-pattern lists alike. A negation keeps its `!` inside `pattern`:
  `{ pattern: '!src/**/*.generated.ts', expectEmpty: true }`.
- The scalar registration-hint `discovery.targetFile` takes the same object.
- Boost maps (search tuning `boostIds` and `taskHints[].boostIds`) take a value
  form instead; the unit is the map key:

  ```ts
  number | { weight: number; expectEmpty: true; reason?: string }
  ```

- `reason` is optional, but recommended: it is printed next to the unit, and a
  marked typo would otherwise stay silent forever (it never goes live).

Loading normalises every markable list into the plain string list every reader
already consumed, plus a marker ledger (`expectEmptyUnits`) on the loaded rule,
source or asset. The one parser is `normalizeUnitList` (`@shrkcrft/core`);
`normalizeUnitMap` and `normalizeUnitScalar` serve the value form and the scalar.

### Refused at load

Each refusal names the entry (`<list>[i]: …`); every bad entry is reported at once.

- an entry that is neither a string nor an object;
- an object with no `pattern` ("a marker naming no unit") — a `glob` / `path`
  key is named as the mistake it is: the unit is `pattern` on every list;
- `expectEmpty` anything but the literal `true` (write the plain string otherwise);
- an unknown key, with a did-you-mean (`reson` → `reason`) — `packageName`
  included: a loader stamps it from pack provenance, no author can write it;
- an empty or non-string `reason`;
- the same unit **marked** twice in one list (plain duplicate strings stay legal);
- a boost value that is neither a number nor a well-formed marker.

The `!` shape rules run on the normalised units, so `{ pattern: '!' }` is refused
exactly like `'!'`. Where a refusal lands:

| Source | Result |
|---|---|
| local `sharkcraft.config.ts` | the config fails to load. Exit 3 on every verdict verb whose rules live in the config — `policy-lint`, `check wiring`, `baseline check`, `generated check`, `docs references check`, `registry <name> …`, `gates check` / `coverage` ([exit-codes.md](exit-codes.md)). `check boundaries` (and MCP `check_boundaries`) and the asset doctors (`registrations doctor`, …) report the unloadable config as a NOT VERIFIED gap — exit 2; `doctor`, `quality` and `finish` read it as their failing config gate — exit 1 |
| a boundary rule (local or pack) | an errored rule, `failed validation — NOT evaluated` — exit 1 |
| a pack gate-plane element or asset | a rejected entry through the round-12 contributions channel (`packs contributions`, `packs list`, `packs test --load`, the ERRORED row) |

`failOnEmpty: true` together with EVERY inclusion unit of the rule's primary list
marked is refused too: every unit asserts "nothing here yet", while
`failOnEmpty: true` asserts an empty result is a failure. Partial marking is legal.

## States

A reporter observes two facts per unit — whether its target **exists** at all
(raw: before exemptions, negations or effectiveness) and whether it is **live**
(it contributes: the plane's existing dead predicate, negated) — and one core
authority, `settleUnitLiveness`, turns them and the marker into a state:

| Marked? | Observed | State | Printed |
|---|---|---|---|
| no | contributes | **live** | nothing (JSON only) |
| no | matches nothing | **dead** | `<unit> — <why> — typo, retired target, or a target that does not exist yet (see expectEmpty)` |
| yes | its target does not exist | **intended-empty** | `<unit> — intended empty (expectEmpty: <reason>) — <why>`, plus `accepted by expectEmpty: …` on the verdict |
| yes | its target exists | **went-live** | `<unit> — expectEmpty is stale: <why it is live> — the fence went live; remove expectEmpty` |
| either | a file that could decide it was not read | **unproven** | no claim either way — the read gap already vetoes (exit 2) |

- Acceptance never claims "does not exist yet" about a target that exists: the
  accepted line quotes what was **observed** (`matched 0 of 4 scanned files`,
  `matches no import anywhere …`).
- A went-live unit whose target exists but contributes nothing (every file under
  it exempt or excluded) keeps its dead weight: it is still a coverage gap, never
  turned from 2 into 0.
- A unit dead by its **shape** (a pattern defect, an allowance a forbidden sibling
  shadows) can never go live, so a marker on it is refused at load.

### How a dead unit weighs

| Weight | Lists | A dead unit |
|---|---|---|
| Advisory | boundary `from` negations, `exemptFiles`, `forbiddenImports`, `allowedImports`; every gate-plane glob | listed, ✓ withheld, exit unchanged |
| Coverage | boundary `from` inclusions; registration hints, scaffold patterns, search tuning | a coverage shortfall — exit 2 |

## A rule that matched nothing

`settleRuleEmptiness` is the one answer for every plane:

- **Intended-empty** — the rule's primary list matched no FILE, nothing was
  unread, and every inclusion unit of that list is intended-empty. Accepted
  (exit 0, printed). A went-live unit counts as live, so it blocks this.
- **Never "0 units out of live files".** A rule whose files matched but yielded
  0 ids / tokens / content units is the stale-extractor loud skip, whatever is
  marked — no marker accepts it.
- **The baselines fence** — `baselines[].expectEmpty` stays the rule-level
  assertion that the OUTPUT is empty. It holds only when the rule's inputs are
  live or intended-empty; a fence over a dead input is stale (it proved
  nothing), exactly like any other empty rule. It composes with a planned input
  marked `{ pattern, expectEmpty: true }`, and it is honoured in `mode: 'ceiling'`.
- Otherwise the rule is **stale**: `failOnEmpty` (on by default for `error`
  rules) makes it exit 1, otherwise exit 2 — and the advice is one sentence:
  `Fix the selector — or, if its target does not exist yet, mark the unit { pattern, expectEmpty: true }`.

## Exit codes

| Exit | When |
|---|---|
| 0 | clean, or accepted — every acceptance is printed (`accepted by expectEmpty: …`) |
| 1 | a violation; an errored rule (a malformed marker in a boundary rule or a pack element); `--fail-on-dead-units` with a dead unit or a LOCAL went-live marker; `--strict` with a local went-live marker on `check boundaries`; a `failOnEmpty` rule that settles stale |
| 2 | a Coverage-weight dead unit; an unread gap; a skipped rule; a stale soft rule |
| 3 | a malformed marker in the local `sharkcraft.config.ts` on a verdict verb whose rules live in the config (see the refusal table above — `check boundaries` and the asset doctors read the unloadable config as `2`, `doctor` / `quality` / `finish` as `1`), or an unknown flag |
| 78 | unchanged — refused by the surface gate |
| 70 | new this round but unrelated to markers: the tool's own install is broken (an unlinked workspace dependency), from the bin bootstrap — see [exit-codes.md](exit-codes.md) |

### `--fail-on-dead-units` and `--strict`

One predicate (`selectorUnitFails`) decides for every surface:

| State | Fails when |
|---|---|
| dead | `--fail-on-dead-units` |
| went-live, local marker | `--fail-on-dead-units`, or `--strict` where `--strict` already promotes warnings (`check boundaries`) |
| went-live, pack marker | never — printed as INFO |
| intended-empty, live, unproven | never |

So with the flag on, the configuration must describe reality exactly: an
unmarked dead unit fails, and so does a stale local marker. That is what makes
`--fail-on-dead-units` safe to turn on in a repo that writes fences ahead of code.

## JSON

The shared `gate` envelope ([gate-json.md](gate-json.md)) gains no always-present
key. Per rule, two OPTIONAL fields:

- `rules[].unitAcceptance` — the rule's acceptance record
  (`{ expected, examined: 0, unexamined, reason: "asserted empty — <observed>", acceptedBy: "expectEmpty" }`),
  folded into the one verdict settle, so it appears in `gate.accepted` — at exit
  0 only, like every acceptance;
- `rules[].units` — `{ dead, intendedEmpty, wentLive }`, each unit as its one
  printed line.

A rule ACCEPTED as intended-empty (its primary list matched no file, every
inclusion unit of it marked) examined nothing, so it is never counted as
evaluated: `gate.evaluated` leaves it out and the optional `gate.acceptedEmpty`
(present only when non-zero) counts it, decided by ONE predicate
(`ruleAcceptedAsIntendedEmpty`). Every text count prints it apart — `N
evaluated, M accepted as intended-empty` on `check boundaries`, `policy-lint`,
`check wiring`, `gates check`, `baseline check`, `generated check` and
`docs references check`. `check boundaries --json` and MCP
`check_boundaries` carry the boundary pair `rulesEvaluated` /
`rulesAcceptedEmpty`. A rule that examined live units beside a planned one (a
registration idiom whose declared role is planned) is evaluated; its acceptance
rides as `rules[].unitAcceptance`.

Every explain view (`gates explain` on any plane, `wiring explain`, `check
wiring --explain`, `policy-lint explain`) lists each unit's state through the
one shared block: dead, went-live (a pack marker as INFO) and intended-empty
(`· <rule id>: <glob> — intended empty (expectEmpty) — …`).

## The layer-root recipe

A layered monorepo fences a layer root beside its family wildcard:

```ts
forbiddenImports: [
  '@scope/kernel-*', // the family: every @scope/kernel-<name>
  { pattern: '@scope/kernel', expectEmpty: true, reason: 'no package lives at the layer root yet' },
]
```

The bare `@scope/kernel` IS load-bearing: `@scope/kernel-*` does not cover it
(the `-` is literal), so the root pattern is what fires the day someone creates a
package at the layer root itself. Mark it — it reads intended-empty until then
and went-live after — or write `@scope/kernel*` knowingly: one pattern for both,
but it also matches `@scope/kernelfoo`.

## Pack authors

A pre-emptive entry is the main pack use case: a framework pack fences a binding
only adopting apps will have.

- The loader or merge seam stamps the contributing pack on each marker. A pack
  marker that went live is printed as INFO and never fails the consumer, not
  under `--fail-on-dead-units` and not under `--strict` — the consumer cannot
  edit it, and the pack cannot drop it without failing consumers that have not
  adopted the target. The pack author removes it in a release.
- A marker spawns no shell, so the shell-executing veto does not apply to it.
  Top-level `extractors` stay local-only, and so do their markers.
- **Markers need engine 0.1.0-alpha.31 or later.** Older engines do not
  understand the object form: on alpha.30 a registration hint with an object in
  `targetGlobs` crashes `registrations doctor` and `self-config doctor`
  (`glob.includes is not a function`), a scaffold `matchPaths` object loads as the
  glob `[object Object]`, and a boost `{ weight, expectEmpty }` is silently
  clamped to 0. Gate-plane config validates its lists as strings, so an object
  entry there fails validation (a local config load error; a pack's gate-plane
  element is dropped with a diagnostic). Boundary rules do NOT: the alpha.30
  validator checks only that `from` / `forbiddenImports` / `allowedImports` are
  arrays, so a boundary rule carrying a marker LOADS and the object entry
  matches nothing — a fence that silently never fires. There is no manifest
  field declaring a minimum engine yet; ship markers only in a pack release that
  requires this engine (see [pack-authoring.md](pack-authoring.md)).
- From this release on, every loader refuses a non-string, non-marker entry (and
  a non-number, non-marker boost value) loudly, through the round-12 rejection
  channel — never a crash, never a silent clamp.

## Every markable list

| List | Where | Weight | Went live when |
|---|---|---|---|
| `from` (inclusions) | boundary rule | Coverage | a scanned file matches it; effective once a governed (non-exempt) file does |
| `from` (`!` exemptions) | boundary rule | Advisory | it exempts a file the rule's `from` globs match |
| `exemptFiles` | boundary rule | Advisory | it exempts a file the rule's `from` globs match |
| `forbiddenImports` | boundary rule | Advisory | an import, a workspace/dependency package name, a tsconfig alias or a file names it |
| `allowedImports` | boundary rule | Advisory | an import matches it, or a package / alias / file resolves it |
| `files` of every extraction source | `wiringRules` declared / registered / chain, `registries` source / consumer, `registrationGraph` roles, `baselines[].compute.source`, top-level `extractors` | Advisory | a file matches it |
| import-edges `to.files` | an `import-edges` source | Advisory | a file matches it (now judged — a typo is no longer a silent pass) |
| `files` | `policyRules[]` | Advisory | a file matches it |
| `watchFiles` | `baselines[]` | Advisory | a file matches it |
| `generatedGlob` | `generatedArtifacts[]` | Advisory | a file matches it |
| `files` | `docReferences[]` | Advisory | a file matches it |
| `discovery.targetGlobs` | registration hint | Coverage | the glob matches a file |
| `discovery.targetFile` | registration hint | Coverage | the file exists |
| `matchPaths` | scaffold pattern | Coverage | the glob matches a file — the pattern itself is intended-empty iff all its globs are |
| `boostIds`, `taskHints[].boostIds` | search tuning | Coverage | the key resolves (only a missing target can be marked — an unprefixed, unknown-kind or excluded key is a defect) |

## By plane

### Boundaries

Every boundary list takes the marker: `from` (inclusions and `!` exemptions),
`exemptFiles`, `forbiddenImports` and `allowedImports`. Local rules, pack
`boundaryFiles`, `--rule-file` and `--diff-against` candidates all load through
the same loader.

```ts
{
  id: 'layer.no-imports-up',
  title: 'Nothing below the app imports up',
  from: ['packages/app/**', { pattern: 'packages/plugin-react/**', expectEmpty: true }],
  forbiddenImports: [
    '@scope/kernel-*',
    { pattern: '@scope/plugin-react', expectEmpty: true, reason: 'ADR-7: planned binding' },
    { pattern: '@scope/kernel', expectEmpty: true, reason: 'no package lives at the layer root yet' },
  ],
}
```

`shrk check boundaries` passes with the acceptance printed under the `✓`:

```
Verdict: OK — no boundary violations. ✓
  layer.no-imports-up: accepted by expectEmpty: examined 0 of 3 selector units, 3 asserted empty: …
```

The day `@scope/plugin-react` appears — a workspace package name, a dependency
declaration, a tsconfig alias, a file, or an import — the marker is stale:

```
expectEmpty markers that went live (1) — each fence now has a target; remove the marker:
  • [forbidden] layer.no-imports-up: @scope/plugin-react — expectEmpty is stale: no import yet, but '@scope/plugin-react' is a known package (…) — the fence went live; remove expectEmpty
Verdict: no boundary violations — 1 expectEmpty unit(s) went live (remove each stale expectEmpty marker).
```

| Unit | A dead unmarked one | Went live when |
|---|---|---|
| `from` inclusion | Coverage: `examined 1 of 2 scope globs` (exit 2) | a scanned file matches it; effective once a governed (non-exempt) file does |
| `from` negation, `exemptFiles` | Advisory | it exempts a file the rule's `from` globs match |
| `forbiddenImports` | Advisory | an import, a workspace/dependency package name, a tsconfig alias or a file names it |
| `allowedImports` | Advisory | an import matches it, or a package / alias / file resolves it |

- A rule whose every `from` inclusion is marked, and that matches no file, is
  accepted (exit 0, printed) — never a `failOnEmpty` failure. Marking every
  inclusion AND setting `failOnEmpty: true` is refused at load.
- A marked `from` glob whose files are all exempt went live but governs
  nothing: it keeps its coverage weight, never 2 → 0.
- `--fail-on-dead-units` fails on an unmarked dead unit and on a LOCAL marker
  that went live; `--strict` — already the warning promoter on this verb —
  fails on the latter too. A pack marker that went live is INFO and never fails.
- Refused at load (an errored rule, exit 1): a rule-level `expectEmpty` /
  `allowDead` / `intendedEmpty` (`expectEmpty is per pattern on a boundary rule`),
  any key that is not a rule field (with a did-you-mean), a marker on a
  defective, redundant or shadowed pattern, a marker on a pattern the judge can
  never call dead (relative, a leading `*`, a runtime builtin — see below), and
  an object `exceptions[].target`.
- An unreadable governed file makes every claim it could refute **unproven** —
  no dead line, no acceptance, exit 2 — on `check boundaries` and on
  `--diff-against` alike.
- The layer root: the bare `@scope/kernel` above is load-bearing — see
  [the layer-root recipe](#the-layer-root-recipe).
- `--json` adds `intendedEmpty`, `wentLive`, `failingUnits` and `accepted`, a
  `state` on every `coverage[].fromGlobs` / `forbidden` / `allowed` /
  `exemptions` row (and `coverage[].unitLiveness`), and
  `coverage[].acceptedAsIntendedEmpty` on a rule accepted as intended-empty
  (counted in `rulesAcceptedEmpty`, never in `rulesEvaluated`); `deadUnits`
  stays unmarked-dead only. MCP
  `check_boundaries` takes `failOnDeadUnits` and returns the same fields;
  `get_boundary_rule` and `list_boundary_rules` add `expectEmptyUnits` (the
  pattern lists stay plain strings); `boundaries explain` and `get_boundary_rule`
  print one `intended empty` line per marker; `shrk explain <ruleId>` resolves a
  boundary rule id. `quality` and `finish` carry dead and went-live units as
  advisory notes that never fail.
- The acceptance is never silent: every surface that settles a boundary run
  prints the settled `accepted by expectEmpty: …` lines — `check boundaries`
  (under the `✓`), `quality` (the boundaries item's notes), `finish` (each
  rule's acceptance is its own envelope row — `gate.accepted`, under its `✓` —
  and `N expectEmpty unit(s) intended empty` in the boundaries sub-gate's
  detail), `drift` and `architecture violations` (under their verdict; `--json`
  `accepted`).
- A PACK marker that went live is printed in its own `INFO — pack expectEmpty
  markers that went live` block on `check boundaries`: it keeps the `✓` and is
  never the consumer's to remove — the same answer `gates coverage` and the
  asset doctors give. A LOCAL one withholds the `✓`.
- A went-live line quotes evidence: an import count, a known package the
  pattern actually matches, an alias or a file.
- A pattern the dead-unit judge can NEVER call dead — a relative one, one with
  a leading `*` (it could match any package name), or one a runtime builtin
  module matches (`fs`, `node:*`) — could only ever read went-live, so a marker
  on it is refused at load (an errored rule, exit 1): `'<pattern>' is marked
  expectEmpty, but <why it is never judged dead> — a marker on it could only
  ever read went-live; write the plain pattern (it needs no expectEmpty)`.

### Wiring rules

Markable: the `files` of `declared`, of every `registered` sink and of every
`chain` hop (and an import-edges side's `to.files`). A rule whose SOURCE side
(`declared`, or `chain[0]`) has every inclusion glob marked and matched no file
is accepted by `check wiring`, `gates check` and `gates coverage` — it used to
fail with `0 files matched the source globs`. Units are named by side
(`declared: src/plugins/**/*.ts`). A subset rule's registered-only tokens stay
the job of `registeredExtras`. Every explain surface runs the same engine settle
— `check wiring --explain`, `wiring explain`, `wiring test`, `gates explain` and
`gates try` read a planned rule as `passed` with its acceptance, never
`SKIPPED … Verdict: errors`, and a candidate carrying a marker is normalised
exactly as the loader normalises it.

```ts
wiringRules: [{
  id: 'plugins-registered',
  declared: { files: ['src/core/*.ts', { pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: 'export const (\\w+)_PLUGIN' },
  registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' },
}]
```

### Registries

Markable: `source.files` and `consumer.files`. An inventory over a planned
directory is intended-empty: every `registry <name>` verb answers as it would
over any inventory — nothing is registered yet, so `list` shows 0 ids,
`duplicates` finds none, and `exists` / `where` answer no. The acceptance is
printed on every answer that exits `0` — `list`, `duplicates`, `exists
--fail-if-taken` over an absent id, and a found `exists` / `where` (plus
`--json` `accepted`); a membership "no" (`exists` / `where` over an absent id)
exits `1` and carries none. `gates check` agrees. A LIVE inventory with a
planned sibling glob prints the same acceptance on the same answers. A registry has no severity of its own, so an empty inventory that is
NOT intended stays `2`, or `1` with an explicit `failOnEmpty: true` (decided by
the one failOnEmpty authority).

### Registration graph

Markable: the `files` of the `declared`, `provided` and `consumed` roles. A role
whose every inclusion glob is marked and matched no file is accepted instead of
`PARTIAL — … consumed (0 files)`; a declared role so marked makes the idiom
intended-empty. The one role measurement (`measureRegistrationRoles`) is what
`gates check`, `gates coverage` and the registration-graph queries (`wiring
unprovided`, `wiring orphans`, `wiring chain`) all fold, so they agree: a chain
over a dead declared role is NOT VERIFIED (2), never `✓ declared → provided →
consumed`, and a role's acceptance is printed under the chain's ✓.

### Baselines

Markable: an extractor compute's `source.files` (and `to.files`), and
`watchFiles`. The rule-level `expectEmpty: true` is a different assertion — it
says the OUTPUT is empty (the fence):

- A fence is accepted only over live or intended-empty inputs. Over a DEAD input
  it is `FAILED — expectEmpty asserts an empty output, but its input selector
  matched nothing …` (`1`; it used to be accepted). Mark a planned input per unit.
- On `mode: 'ceiling'` the rule-level `expectEmpty` stays legal: an empty
  measurement is then a verified `0`, judged against the ceiling.
- A ceiling over an extractor that measured nothing is a loud skip on `baseline
  check`, `gates check` and `gates coverage` alike (the empty test counts the
  extractor's units, never its serialised text).
- `baseline update` asks the same settle before blessing an empty recompute: a
  failOnEmpty rule whose input is dead (or whose live files yielded nothing) is
  refused, naming the dead selector; a fence over live inputs and an
  intended-empty input are blessed.
- The two compose: a fence to a planned subtree is
  `to: { files: [{ pattern: 'packages/plugin-react/**', expectEmpty: true }] }`
  plus `expectEmpty: true` on the rule — two acceptances, both printed.

### Shared extractors and import-edges

A top-level `extractors.<id>.files` list may mark units. Every `$use` consumer
inherits the markers together with the `files`; a consumer that spells its own
`files` replaces them (markers travel with the list they mark), and a resolved
marker that names no unit of its list is a load error. Extractors are
local-only, so their markers are too.

An import-edges `to.files` is **judged for liveness** from this round: an
unmarked target glob that matches no file is an advisory dead unit (a typo'd
fence target used to pass silently). It is also markable — the fence to a
planned subtree above. A verified fence never prints the barrel hint.

### Policy rules

Markable: the rule's own `files` (a surface's default globs are not a selector
anyone wrote). `policy-lint`, `gates check` and `gates coverage` accept a rule
over a planned directory; a marked negation that excludes nothing yet
(`{ pattern: '!src/**/*.generated.ts', expectEmpty: true }`) is intended-empty
and goes live the day it excludes a file. `exemptFiles` is not markable.

### Generated artifacts

Markable: `generatedGlob`. A header-only rule over a planned tree is accepted by
`generated check`, `gates check` and `gates coverage`. `sources[].glob`,
`outsideGlob` and `handMaintained` are not markable.

### Doc references

Markable: `files`. A rule over a planned doc directory (`docs/adr/**`) is
accepted by `docs references check`; documents that matched but cite no token
are still the loud skip — never assertable. A pack contributes doc-reference
rules through the `docReferenceFiles` slot, and a malformed marker in one is
refused like on every other plane.

### Registration hints

`discovery.targetGlobs` entries and `discovery.targetFile` take the marker. A
marked selector that matches no file is intended-empty: `registrations doctor`
prints `registration hints: accepted by expectEmpty: …` (exit 0), and a hint
whose every empty selector is marked reads `intended-empty`, never `dead`
(`totals.intendedEmpty`). Existence and liveness are one predicate here (the
file exists / the glob matches a file); a zero from a walk that hit its
directory cap is unproven, never intended-empty. Once a file matches, the
selector went live (`discovery-went-live`, info): ✓ withheld, and
`--fail-on-dead-units` fails a local marker (1). A fixed `targetFile` wins over
`targetGlobs` — the globs of such a hint are never walked — so a marker on one
of its `targetGlobs` is refused at load (`a marker on a list this hint's
discovery mode never judges`, a rejected entry — `registrations doctor`'s
`invalid-hint`, `packs test --load`) instead of vanishing; mark `targetFile`. See
[registration-hints.md](registration-hints.md).

### Scaffold patterns

`matchPaths` entries take the marker. One planned path is ONE acceptance: the
derived pattern-level unit (the pattern matching no file after `excludePaths`)
is not authored, so it cannot be marked — it is left out of its record when
EVERY glob of the pattern is intended-empty, where it used to add a second dead
unit (`dead: 2` for one fact). A marked glob beside a dead sibling keeps the
pattern judged. `scaffolds doctor` and MCP `get_scaffold_pattern_doctor` read
one report and propose through one rule, so both carry `accepted`, `rejected`,
`verdict` and `exitCode`. See [scaffold-patterns.md](scaffold-patterns.md).

### Search tuning

`boostIds` / `taskHints[].boostIds` VALUES take `{ weight, expectEmpty: true,
reason? }`; the unit is the key, settled once per distinct key. A missing
target every declaration of which is marked is intended-empty (an unmarked
declaration of the same key is a boost that never fires, so the key stays
dead); a marked key that resolves went live. The weight is kept — never clamped
to 0 — and a non-number, non-marker value, or a marker on a key that can never
fire (unprefixed, an unknown kind, excluded by the entry's `appliesToKinds`), is
a rejected entry. A marker never accepts an UNVERIFIABLE key (its kind's
registry is empty, or the document kind has none): that stays a coverage gap
(2). See [search-tuning.md](search-tuning.md).

### Self-config doctor

The aggregate: every family's settled records — the dead shortfall and the
expectEmpty acceptance — ride into its coverage, so the acceptances print under
the clean line and in `--json` `accepted`; `selectorUnits` carries every
non-live unit's state and marker, and `--fail-on-dead-units` decides on it
through the one asset-doctor proposal MCP uses too. `--json` carries the settled
`exitCode` / `settledVerdict` / `shortfalls` / `accepted` next to the report's
own `verdict`, and MCP `get_self_config_doctor` carries the same four.
`self-config report` settles the same verdict and is a registered verdict verb
(a bad flag is 3). Routing hints that can never match are dead by shape and
cannot be marked. See [self-config-doctor.md](self-config-doctor.md).

## Not markable (and why)

- `exceptions[].target` — an exception adjudicates a real edge; a stale exception
  is an error by design, and an object target is refused.
- A shadowed, defective or redundant pattern — dead by its shape; fix the pattern.
- A boundary pattern the judge can never call dead — a relative one, a leading
  `*`, one a runtime builtin module matches — it could only ever read
  went-live, and it needs no marker: write it plain.
- A `targetGlobs` entry of a registration hint with a fixed `targetFile` — the
  globs of such a hint are never walked; mark `targetFile`.
- The `excludeTests` shorthand (already allowed to be vacuous), and a subset
  wiring rule's registered-only tokens (`registeredExtras` already says that).
- A command baseline without `watchFiles` (nothing was measured — add
  `watchFiles`), a doc-reference rule that matched documents but cited no token,
  and a `resolvesAs` kind with no registered ids (reference existence belongs to
  the one id resolver).
- Targets that can never exist: a search-tuning task hint that can never apply, a
  routing hint with no scored criterion, a custom check that can never run.
- `reuse coverage` entries, knowledge stale-check references (they have their own
  valves), constructs-trace globs, generated `sources[].glob` / `outsideGlob` /
  `handMaintained`, and policy `exemptFiles`.

## See also

[boundaries.md](boundaries.md) · [gate-rules.md](gate-rules.md) ·
[extraction-dsl.md](extraction-dsl.md) · [baseline-drift.md](baseline-drift.md) ·
[exit-codes.md](exit-codes.md) · [gate-json.md](gate-json.md) ·
[registration-hints.md](registration-hints.md) · [scaffold-patterns.md](scaffold-patterns.md) ·
[search-tuning.md](search-tuning.md) · [self-config-doctor.md](self-config-doctor.md) ·
[pack-authoring.md](pack-authoring.md)
