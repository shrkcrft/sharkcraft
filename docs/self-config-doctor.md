# Self-config doctor (R33 v1 / R38 v2)

`shrk self-config doctor` walks the *graph* of cross-references inside
the workspace + pack contributions and reports broken links, duplicate
ids, missing referenced ids, and stale pack signatures.

## Commands

```bash
shrk self-config doctor [--schema v1|v2] [--format text|markdown|json] [--strict] [--fail-on-dead-units] [--json]
shrk self-config graph [--format json|mermaid|dot]
shrk self-config broken-links [--json] [--allow-empty]
shrk self-config report [--schema v1|v2] [--output <dir>] [--strict] [--fail-on-dead-units] [--json]
shrk self-config resolve <id> [--json]        # which registry an id lives in + who points at it
shrk self-config xrefs [--source <kind>:<id>] [--dangling-only] [--json]
```

`--strict` returns a non-zero exit code on **any** warning (not just
errors). `--schema v1` opts back into the legacy R33 report shape; the
default is v2.

## R38 — v2 schema (`sharkcraft.self-config-doctor/v2`)

Each finding carries:

- `id` — stable identifier `sourceKind:sourceId|relation|targetKind:targetId`.
- `severity` — `info` / `warning` / `error`.
- `code` — finding code (e.g. `agent-test-helper-missing`).
- `sourceKind` / `sourceId` — the entity *referencing*.
- `targetKind` / `targetId` — the entity being referenced. Every reference
  kind names itself (`knowledge`, `construct`, `workspace-profile`, …), plus
  `search-document` (a `<prefix>:<id>` search document whose prefix has no id
  registry — `doc:README.md` — or the cap summary `N more document(s)`),
  `schema` (a declaration-shape finding, relation `validates`, whose id is the
  field path — `taskHints[1].whenTokens`, `facets.bad-kind[k1]`), `file`, and
  `unknown` — **reserved for a target that resolves in no registry** (see
  "`unknown:` means resolves nowhere" below). `sourceKind` adds `self-config`,
  the doctor itself.
- `relation` — `references` / `expects` / `validates` / `requires` /
  `produces` / `routes-to` / `tunes` / `documents` / `supersedes` /
  `related`.
- `file` — optional originating file.
- `message`, `suggestedFix`, `nextCommand`.
- `confidence` — `high` (loader-backed) / `medium` / `low` (regex /
  fallback).

Cross-reference checks added in R38 (introduced with v2; since round 11 v1 is a
projection of v2 — see "One doctor" below — so both shapes report them):

- agent-tests → helpers / playbooks / policies / commands
- policies → rules / commands / paths
- pipelines → templates / commands
- playbooks → templates / pipelines
- registration hints → templates / conventions / profiles
- decisions → rules / policies / files (prose tokens filtered out)

## Command strings (round 11)

Every command string an asset prescribes is resolved through THE injected
command resolver (the live command index — `shrk surface list`), deduped per
(asset, command):

| asset | field | severity when it does not resolve |
|---|---|---|
| agent tests | `expectedCommands` | error (the test can never pass) |
| routing hints | `recommends.commands` | warning |
| registration hints | `validationCommands` | warning |
| pipelines | `steps[].cliCommands` | warning |
| playbooks | `steps[].commands` | warning |
| constructs | `commands` | warning |
| presets | `recommendedNextCommands` | warning |
| knowledge | `actionHints.commands`, `references` of kind `command` | warning |
| decisions (TS) | `relatedCommands` | warning |

Finding code `unknown-command` (`targetKind: 'command'`, `targetId` = the
string, the resolver status and reason in `message`, the closest real command
in `suggestedFix`). `prefix-only` (a proven verb whose internally-dispatched
tail cannot be proven) and `not-shrk` (git, tsc, …) are counted, never flagged.

The two command-REFERENCE sites — agent-test `expectedCommands` and knowledge
`references` of kind `command` — are read the way `shrk test agent` and
`shrk knowledge stale-check` read them (one resolver, one reading): a bare
command-word head names a shrk verb, so `doctor` resolves and `frobnicate` is
`unknown-command`, unless the head is a package manager or a known executable
(`bun test`, `git status`). Every other site is free shell text and is not
given that assumption.

`not-shrk` strings are a deliberate narrowing of the `command strings`
coverage (not this engine's to judge), never counted as examined; the clean
line names them and any `prefix-only` tails it could not prove.

The report carries `probes.command = { probed, exists, prefixOnly, notShrk,
unknown, unverified }`. Without an injected resolver (a direct engine call, the
MCP server) nothing is checked: `unverified = probed` and ONE info finding
`command-probe-unverified` (source `self-config:command-probes` — the doctor
itself; it read `unknown:self-config` before round 12) says so — never a
finding per command, never an error. The CLI always injects the resolver; its exit settles against the
`command strings` coverage, so an unchecked probe can never read as a pass.

Before round 11 these probes checked against a set initialised EMPTY, so every
command in every hint was "unregistered" — including correct ones, and a
correct agent-test `expectedCommands` entry failed the doctor at error
severity.

## One doctor (round 11)

`--schema v1`, the MCP `get_self_config_doctor` tool and `fix preview
--self-config` used to run a SECOND doctor with its own checks, so the CLI and
MCP answered "is my config healthy?" differently. v1 is now a projection of v2
(`projectSelfConfigDoctorV2ToV1`): `sourceId` → `referencingId`, `targetId` →
`referencedId`, `targetKind` → `referencedKind`, `file` → `sourceFile`, and the
v2 code `pack-signature-stale` → `pack-conflict:stale-signature`. Same checks,
two shapes. A repeated finding merges (`occurrences`), so finding ids are
unique.

## Declared cross-references (round 11)

Assets point at each other by id in `related`-style fields. None of it used to
be resolved: a renamed or deleted asset left dangling ids behind while every
doctor printed ✓. ONE table — `DECLARED_XREF_FIELDS` in
`packages/inspector/src/declared-cross-references.ts` — says which fields carry
ids; every id is resolved through the ONE reference registry. The doctor,
`broken-links`, `resolve`, `xrefs`, `packs doctor`, `templates drift`,
`knowledge remove` and `shrk quality` all read this collector.

| source | field | accepts | a dangling / wrong-kind id is |
|---|---|---|---|
| knowledge | `related`, `seeAlso` | any kind | warning |
| knowledge | `supersededBy` | knowledge | **error** — it routes a reader |
| knowledge | `actionHints.relatedKnowledge` / `relatedTemplates` / `relatedPathConventions` | knowledge / template / path-convention | warning |
| construct | `relatedKnowledge` / `relatedRules` / `relatedTemplates` / `relatedPipelines` / `relatedPathConventions` | knowledge / rule \| boundary-rule / template / pipeline / path-convention | warning |
| construct | `facets.<name>[]` values that declare `resolvesAs` | the declared kinds | warning (an unknown kind name is an **error**) |
| boundary rule | `relatedRules` / `relatedPathConventions` | rule \| boundary-rule / path-convention | warning |
| template | `related` | any kind | warning |

Finding codes: `xref-dangling` (resolves in no registry), `xref-wrong-kind`
(resolves only in a kind the field does not accept — a template id in
`relatedRules`), `xref-unverified` (info: the registry it would resolve in was
not warmed, or is empty), `xref-unknown-kind`, `xref-superseded-cycle` (error:
no entry in the cycle is current), `xref-superseded-chain` (warning: the
successor is itself superseded — the finding names the current entry) and
`xref-malformed` (a field that is not a list of string ids). Each finding's
`nextCommand` is `shrk self-config resolve <id>`, and `suggestedFix` carries the
nearest registered id. `xref-unknown-kind` / `xref-malformed` are about the
DECLARATION, so they target `validates schema:<field>[<facetId>]`
(`facets.bad-kind[k1]`) — the facet value may well resolve; its declared kind
is what is wrong (it read `related unknown:<value>` before round 12). The
collector's issue carries `facetId` for them.

The report adds `crossReferences: { examined, counts, summary }`; the text
renderer prints one line — `xrefs  N id(s) across M field(s) · D dangling · W
wrong-kind · U unverified`, or `none declared — nothing examined`. Its coverage
record (`declared cross-references`, unit `declared cross-reference ids`) rides
in `coverage`, so an id that could not be looked up is a shortfall — the doctor
settles to 2, never a pass. A workspace with no declared ids contributes no
record. v1 is a projection of v2, so the MCP `get_self_config_doctor` reports
the same findings.

`broken-links` and `graph` gain one edge per declared id (`relation` = the
field); dangling and wrong-kind ones are `brokenEdges`, so `broken-links`
agrees with the doctor. It exits 0 none · 1 broken · 2 an id could not be
looked up, or there was nothing to examine (no file reference and no declared
cross-reference id — `--allow-empty` accepts an empty scope, printed as
accepted). The MCP `get_self_config_graph` returns the same composition.

**Lookup verbs.** `resolve <id>` prints every kind whose registry lists the id,
most specific first (`ALL_ID_REFERENCE_KINDS` is ordered by specificity: a
rule id reads `rule` before `knowledge`), each with the verb that shows it, plus
every declared field pointing at the id, and did-you-mean when it resolves
nowhere (exit 0 resolved · 1 unresolved · 3 no id). `xrefs` prints the
extracted set with each id's namespace and status (`--source <kind>:<id>`,
`--dangling-only`); a malformed `--source` exits 3.

## Search-tuning boost keys

A boost key is a SEARCH-DOCUMENT id, `<kind>:<id>` — the matcher compares it to
the document id whole. Valid prefixes: `knowledge`, `rule`, `path`, `template`,
`pipeline`, `boundary`, `construct`, `playbook` (resolved within that kind),
and `preset`, `pack`, `bundle`, `session`, `facet`, `doc` (no id registry —
reported unverified, never missing). The key is split on its FIRST `:`.

| status | finding (warning) | meaning |
|---|---|---|
| resolved | — | the boost can fire |
| missing | `search-tuning-target-missing` | no such id in that kind |
| unprefixed | `search-tuning-key-unprefixed` | a bare id never matches a document; `suggestedFix` names the prefixed key |
| unknown-kind | `search-tuning-key-unknown-kind` | the prefix is not a document kind (`knowlege:` → `knowledge:`) |
| unverified | — | counted, and a coverage shortfall |

Plus the rest of THE search-tuning lint (shared with `shrk search tuning
doctor`): `boost-excluded-by-kind`, `duplicate-trigger`, `unreachable-trigger`,
`unknown-kind`, `unknown-source`, `cap-discards` (info), and the loader's own
issues (`search-tuning-load-failed`, `-missing-file`, `-boost-clamped`).
Before round 11 the whole prefixed key was looked up in bare-id registries:
every correct key was reported missing and every dead bare key passed.

Each finding's target is what the issue names (round 12, 12.4 — the table is
in `docs/search-tuning.md`): a key or document the resolvers place reads
`tunes <kind>:<id>` (`cap-discards` on `knowledge:gamma.entry` →
`knowledge:gamma.entry`, a resolvable bare key → its kind), a registry-less
document or key and the cap summary read `search-document:`, a trigger /
vocabulary finding or a clamped tag reads `validates schema:<field>`
(`taskHints[1].whenTokens`, `appliesToKinds`, `boostTags.<tag>`), and only a
key that resolves nowhere reads `unknown:<the whole key>`.

## `unknown:` means resolves nowhere (round 12, 12.4)

A finding's `targetKind` is `unknown` ONLY when its target id resolves in no
registry, as THE id resolver (`referenceKindsOf`) or THE key resolver
(`resolveSearchTuningKey`) answered. `selfKindOf` is a table over every
reference kind (a kind added without a row is a compile error) and only
`selfKindOf(undefined)` yields `unknown`; a source lock and a property test
(every `unknown` target resolves nowhere, over fixtures and this repository)
hold it.

The genuine cases: a search-tuning key that resolves nowhere, a pipeline step
reference that resolves nowhere (`pipeline-reference-missing`), and an
`accepts: "any"` cross-reference id that no registry has (`xref-dangling`). A
pipeline step reference that resolves as ANOTHER kind (a construct) is
`pipeline-reference-wrong-kind` (info, `next: shrk self-config resolve <id>`),
labelled with the kind it resolved as; the exit-0 line counts it (`N wrong-kind
reference(s) reported as info above`) instead of certifying every probe
resolved.

**BEHAVIOUR CHANGE.** Exits, verdicts, severities and coverage are unchanged.
For the `search-tuning-*`, `xref-unknown-kind` / `xref-malformed`,
`pipeline-reference-*` and `command-probe-unverified` codes, the finding `id`,
`targetKind` / `targetId` / `relation`, `totals.byTargetKind` / `byRelation` /
`bySourceKind` and the v1 `referencedKind` / `referencingId` (the MCP
`get_self_config_doctor` default) change — e.g.
`search-tuning:t.cap|tunes|unknown:knowledge:gamma.entry` is now
`search-tuning:t.cap|tunes|knowledge:gamma.entry`. `unreachable-trigger`
findings in different task hints of one entry are no longer merged into one ×N
finding, so the warning count can rise. The same fields change for the
round-12 (12.3) profile relabel: `registration-hint-profile-missing`,
`template-profile-missing` and routing `recommends.profiles` /
`recommends.paths` misses name the kind the id was resolved against — `profile`
→ `workspace-profile` / `migration-profile`, `path` → `path-convention` — in
`targetKind`, the `totals.byTargetKind` key and the v1 `referencedKind` (the MCP
`get_self_config_doctor` default shape); a coverage record's unexamined labels
read `<source> → <kind> <id>` the same way.

## Probes, coverage and the `unverified` verdict (round 11)

`probes` carries one line per family: `command`, `search-tuning-target`
(`probed / resolved / missing / unprefixed / unknownKind / unverified`, over
distinct keys) and `routing-hint-target`. `coverage` is the per-unit record
list the verdict and the CLI exit are BOTH derived from (core's
`coverageShortfall`):

| subject | unit | examined |
|---|---|---|
| — | command strings | resolved through the injected command index |
| search tuning | boost keys | keys that fire (resolved and admitted by `appliesToKinds`) |
| search tuning | task hints | hints whose every `whenToken` a query can produce |
| routing hints | hints | hints with a keyword, phrase or compiling regex |
| routing hints | recommended ids | ids whose kind's registry is non-empty |
| registration hints | discovery selectors | fixed targets / globs matching a file |
| registration hints | related ids | `discovery.conventionIds` (→ `convention`) / `profileIds` (→ `workspace-profile`) checkable |
| conventions | applicability profile ids | `appliesTo.profileIds` (→ `workspace-profile`) checkable |
| templates | required ids | `metadata.requiredProfileIds` / `requiredConventionIds` / `requiredHelperIds` / `registrationHintIds` checkable |
| scaffold patterns | matchPaths globs / patterns | matching at least one file |

**Round 12 (12.3).** Every id-list field above is bound to its kind by ONE
table (`PROBED_ID_FIELDS`) and probed through THE resolver's loud-skip path.
`profileIds` / `requiredProfileIds` are WorkspaceProfile ids and resolve
against the builtin `workspace-profile` kind (`shrk profiles list --kind
workspace`), which is never empty — so a real profile passes and a typo is a
`registration-hint-profile-missing` / `convention-profile-missing` (info) or
`template-profile-missing` (warning) finding with a did-you-mean and `next:
shrk profiles list --kind workspace`. They used to be checked against
MIGRATION profiles: NOT VERIFIED forever with none declared, a false "not
registered" with any. A template id checked against an EMPTY registry (a
`requiredConventionIds` with zero conventions) is now an unexamined unit
(NOT VERIFIED, exit 2) instead of a warning. When a unit could not be checked
because its kind's registry is empty, the reason names how to fill that kind,
from the declaration table: `… — declare migration-profile via pack key
migrationProfileFiles · sharkcraft/migration-profiles.ts …`. Finding
`targetKind` is always the kind the id resolved against (`workspace-profile`,
`migration-profile`, `path-convention`) — the `profile` / `path` relabels are
gone.

**The clean line.** At exit 0, "No cross-reference issues — every checked probe
resolved ✓" is printed only when it is true. An info-severity unresolved
reference (any `*-missing` finding) never fails the run, but it is counted —
`No blocking cross-reference issues — N unresolved reference(s) reported as
info above.` — never certified as resolved.

`verdict` is `errors` (any error) → `unverified` (any shortfall: a dead or
unverifiable unit) → `warnings` → `ok`. The CLI exits 1 on errors (or warnings
under `--strict`, or any dead unit under `--fail-on-dead-units`), else 2 when
any record has a shortfall, else 0 — the ✓ line is printed only at 0.
`deadUnits` lists every dead unit.

### Intended-empty units and the settled verdict (round 13)

The selector families — registration discovery, scaffold `matchPaths`, search
tuning keys (and routing hints, which cannot be marked) — settle through THE
liveness authority, so a unit marked `{ pattern | weight, expectEmpty: true }`
([intended-empty.md](intended-empty.md)) arrives here already decided:

- an intended-empty unit's family carries an `acceptedBy: expectEmpty` coverage
  record, printed under the clean line (`scaffold patterns: accepted by
  expectEmpty: …`) and in `--json` `accepted` — never a dead unit;
- `selectorUnits` (v2 JSON) lists every selector unit that is not live — dead,
  intended-empty, went-live or unproven — with its state and marker;
- `--fail-on-dead-units` fails a dead unit or a stale LOCAL marker (a
  `*-went-live` info finding), through the same rule every asset doctor and
  MCP use (`assetDoctorProposedExit`); a pack's stale marker never fails. A
  stale local marker is counted in the clean line instead of certified.
- The dead-unit hint names the third explanation: `Fix each dead unit (N) —
  typo, retired target, or a target that does not exist yet (see expectEmpty)`.

`--json` (both schemas) carries the SETTLED verdict next to the report's own
`verdict` (`ok` / `warnings` / `errors` / `unverified`, unchanged):
`exitCode`, `settledVerdict` (`pass` / `fail` / `not-verified` — the sibling
doctors' `verdict` vocabulary), `shortfalls` and `accepted`. MCP
`get_self_config_doctor` carries the same four fields (settled without the
CLI's flags; MCP has no command index, so prescribed command strings stay NOT
verified there).

`shrk self-config report` settles the same verdict — `--strict` and
`--fail-on-dead-units` included — and is a registered verdict verb: its 2
survives a pipe (`--exit-trailer`), a bad flag is 3, and `--json` prints
`{ written, schema, verdict, exitCode, settledVerdict, shortfalls, accepted }`.

The unresolvable-reference scan (`unresolvableReferences`, and so `shrk packs
contributions`) now covers search-tuning boost keys exactly as `shrk search
tuning doctor` does: a key its resolver could not check — its kind's registry
is empty (`registry-empty`), or the document kind has no id registry at all
(kind `search-document`, `undeclarable-kind`) — is an unresolvable reference of
the tuning file that declares it.

The routing-hint, registration-hint and scaffold-pattern loaders' issues reach
the doctor: `routing-hint-invalid` / `-duplicate-id` (error — since round 12
reported by the rejection family below, once), the routing load
lints (`routing-hint-invalid-regex`, `-empty-trigger`, `-duplicate-trigger`,
`-unscored-match-criteria`, `-unknown-recommends-key`, …), every
`registration-hint-*` discovery finding, and `scaffold-pattern-matchPaths-matched-nothing`
/ `-pattern-dead`. Routing `recommends` ids are probed per channel through one
table (templates, playbooks, helpers, profiles, conventions, knowledge,
policies, pipelines, rules, paths). Every pack contribution conflict is
reported (`pack-conflict:<kind>`), not only stale signatures.

## Rejected entries (round 12, 12.1)

Every declared contribution entry a loader REFUSED — from THE rejection
channel (docs/pack-contributions.md "Rejected entries") — is an **ERROR**, one
finding per failing field: `<kind>-invalid`, or `<kind>-duplicate-id` for a
reused id. Local and pack alike: an entry that never takes effect is a defect.
It used to reach no surface but its kind's own doctor (conventions, helpers)
— or none at all (knowledge, templates, pipelines, playbooks, constructs, …).

```
error   [convention-invalid] convention:conv.b validates schema:severity
         convention "conv.b" in node_modules/@acme/pack/conventions.ts (default[8]) was rejected by its loader — severity: severity must be one of: info, warning, error (got undefined). It does not take effect.
         next: shrk packs contributions --pack @acme/pack
```

- The finding kind (also the code prefix) comes from ONE table over every
  contribution kind — never a fallback: `knowledge`, `rule`,
  `path-convention`, `docs`, `template`, `pipeline`, `preset`,
  `boundary-rule`, `scaffold-pattern`, `policy`, `construct`,
  `construct-facet`, `playbook`, `search-tuning`, `feedback-rule`,
  `decision`, `contract-template`, `migration-profile`, `context-test`,
  `agent-test`, `helper`, `routing-hint`, `registration-hint`, `convention`,
  `delegate-recipe`, `framework-extractor`, and the gate planes
  (`wiring-rule`, `registry`, `registration-idiom`, `policy-rule`,
  `reuse-primitive`, `baseline`, `generated-artifact`).
- `sourceId` is the entry's id, or `<file>:<export>[<index>]` for an id-less
  one; `targetId` is the failing field; `next:` is `shrk packs contributions
  --pack <name>` for a pack entry, else the kind's doctor.
- BEHAVIOUR CHANGE: a contract template, a migration profile and a search
  tuning entry with no id rise from a loader warning to this ERROR, so
  `self-config doctor` exits 1 on them (`profiles doctor` and `search tuning
  doctor` keep their warnings and exits).
- A `*-missing` finding whose target id matches a REJECTED entry says so
  instead of offering a did-you-mean: `'conv.b' is declared in
  node_modules/@acme/pack/conventions.ts but was rejected: severity: …`.
- `unresolvableReferences` lists every declared reference the reference
  probes could not check (`registry-empty` / `undeclarable-kind`), attributed
  to its file and field — the list `shrk packs contributions` groups per file.
- A step-less playbook no longer crashes the doctor (`p.steps.forEach`): the
  loader refuses it (`playbook-invalid`, `steps: must be an array`).

## What it checks

- Knowledge entries → file references resolve on disk.
- Knowledge entries → command / anchor / symbol references (delegated
  to `shrk knowledge stale-check`).
- Search-tuning boost keys resolve within their `<kind>:` (see above).
- Agent-test `expectedKnowledge` / `expectedTemplates` / helpers / playbooks /
  policies ids exist.
- Routing hints, registration hints and scaffold patterns (see above).
- Pipeline step `references` name a knowledge entry, template, path
  convention, convention or helper: `pipeline-reference-missing` (resolves
  nowhere) / `pipeline-reference-wrong-kind` (resolves as another kind), info.
- Pack contribution conflicts (duplicate ids / shadowed / invalid /
  missing-loader / stale-signature).

## MCP

- `get_self_config_doctor` — read-only report, `schema: "v1"` (default) or
  `"v2"`. The same checks as the CLI; command strings are reported NOT
  verified (the command index lives in the CLI), so the verdict there is
  `unverified` whenever assets prescribe commands.
- `get_self_config_graph` — read-only graph (nodes + edges +
  brokenEdges; supports `json | mermaid | dot` render via CLI).

## Schemas

- `sharkcraft.self-config-doctor/v1`
- `sharkcraft.self-config-graph/v1`
