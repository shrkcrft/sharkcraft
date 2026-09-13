# Registration hints (R35)

Pack-driven downstream registration. The engine ships zero hints; every
entry comes from a pack contribution (`registrationHintFiles[]`).

## Why

A generated construct often needs a downstream registration step that the
engine cannot guess — e.g. wire a plugin into the composer, add a route
entry, register a capability. Packs declare the *shape* of those steps as
**registration hints**; the engine surfaces them as previews. Apply stays
human-driven.

## Shape

```ts
interface IRegistrationHint {
  id: string;
  title: string;
  description?: string;
  variables?: { name; required; description?; defaultValue? }[];
  discovery: {
    targetFile?: string | { pattern; expectEmpty: true; reason? };        // fixed relative path
    targetGlobs?: readonly (string | { pattern; expectEmpty: true; reason? })[]; // glob candidates
    conventionIds?: readonly string[];      // convention ids the target should satisfy — a cross-reference the doctor resolves, NOT a filter
    profileIds?: readonly string[];         // WorkspaceProfile ids (`shrk profiles list --kind workspace`)
  };
  operations: ReadonlyArray<IRegistrationHintOperation>;
  requiresHumanReview?: boolean;
  validationCommands?: readonly string[];
  safetyNotes?: readonly string[];
  tags?: readonly string[];
}
```

`IRegistrationHintOperation` mirrors the plan-v2 source operation kinds
(`ensure-import`, `insert-enum-entry`, `insert-object-entry`,
`insert-before-closing-brace`, `insert-between-anchors`, `insert-after`,
`insert-before`, `append`, `export`).

## Commands

```bash
shrk registrations list [--source local|pack] [--json]
shrk registrations get <id> [--json]
shrk registrations doctor [--json] [--strict] [--fail-on-dead-units] [--allow-empty]
shrk registrations preview <id> [--var key=value ...] [--json]
```

Preview is **read-only**. Ambiguous discovery (multiple glob matches)
emits `ambiguous: true` and refuses to guess.

## Doctor (round 11)

`shrk registrations doctor [--json] [--strict] [--fail-on-dead-units]`
verifies every hint's discovery through THE discovery authority
(`resolveRegistrationHintCandidates` — the candidate set `preview` acts on;
the walk skips `node_modules` / `dist` / … and reports a truncated walk as
`capped` instead of silently stopping):

| status | when | finding |
|---|---|---|
| verified | a fixed `targetFile` exists, or discovery matches exactly one file (its anchors are checked) | `anchor-not-present` (info) per missing anchor |
| ambiguous | discovery matches more than one file | `discovery-ambiguous` (info) |
| dead | a missing fixed target, a glob matching nothing, or no discovery | `target-file-missing` / `discovery-dead` / `discovery-missing` (warning), plus `discovery-glob-matched-nothing` (warning) for EACH dead glob, even beside a live one |
| unverified | a discovery walk hit its directory cap | `discovery-unverified` (info) |
| intended-empty | no file yet, and every selector that matched nothing is marked `expectEmpty` (round 13) | `discovery-intended-empty` (info) per marked selector |

The header reads `N hint(s): V verified · A ambiguous · D dead · U unverified`,
followed by `· I intended-empty` whenever at least one hint reads intended-empty
— "0 issues" is never "N verified". A fixed `targetFile` wins over
`targetGlobs` (the globs of such a hint are never walked), so an `expectEmpty`
marker on one of its `targetGlobs` is refused at load — `discovery.targetGlobs[i]:
a marker on a list this hint's discovery mode never judges …`, a rejected entry
(`invalid-hint`, and `packs test --load`) — instead of being dropped silently;
mark `targetFile` itself. `--json` carries `hints[]` (`id`,
`discovery`, `candidates`, `status`), `totals`, `coverage` (`discovery
selectors`) and `deadUnits`. Exit: 1 on errors (warnings with `--strict`, dead
units with `--fail-on-dead-units`), 2 when a selector matched no file, a walk
was capped, or no hint is declared at all (nothing was verified —
`--allow-empty` accepts that, and the acceptance is printed), else 0. The self-config doctor reports the same findings
(`registration-hint-<code>`) and probes `discovery.conventionIds` (against
conventions) / `discovery.profileIds` (WorkspaceProfile ids, against the builtin
`workspace-profile` kind — round 12; a typo is `registration-hint-profile-missing`
with a did-you-mean).

## Intended-empty discovery (round 13)

A hint written before the adopting app has its target — a pack's route-table
hint, a plugin registry that lands next sprint — marks the selector instead of
deleting it ([intended-empty.md](intended-empty.md)):

```ts
discovery: {
  targetGlobs: ['src/app/**/app.ts', { pattern: 'src/plugins/**/registry.ts', expectEmpty: true, reason: 'plugins land in v2' }],
  // or: targetFile: { pattern: 'src/app/routes.ts', expectEmpty: true },
}
```

- The loader normalises a marker to its plain glob / path (what `preview` acts
  on) plus the hint's `expectEmptyUnits` ledger, stamped with the contributing
  pack. A malformed marker (no `pattern`, `expectEmpty` not the literal `true`,
  an unknown key, the same unit marked twice) and any entry that is neither a
  string nor a marker make the hint a REJECTED entry (`invalid-hint`, reason
  `discovery.targetGlobs[<i>]: …`) on every surface — `registrations doctor`
  (exit 1), `packs contributions`, `packs test --load`, `self-config doctor` —
  never the `glob.includes is not a function` crash an older engine hits.
- While the marked selector matches nothing it is **intended-empty**: a
  `discovery-intended-empty` info finding, no dead unit, and a printed
  acceptance on the verdict (`registration hints: accepted by expectEmpty: …`,
  `--json` `accepted`). A hint whose every empty selector is marked reads
  `intended-empty`, never `dead`, and counts in `totals.intendedEmpty`.
- Once it matches a file it **went live** (`discovery-went-live`, info:
  `expectEmpty is stale: … — the fence went live; remove expectEmpty`). The ✓ is
  withheld and the exit is unchanged, except that `--fail-on-dead-units` fails a
  LOCAL stale marker (1). A pack's stale marker is INFO and never fails the
  consumer, who cannot edit it. `--strict` does not promote a stale marker.
- `--json` adds `units: { dead, intendedEmpty, wentLive }` — one printed line
  per unit.

A marker needs engine 0.1.0-alpha.31 or later — see the forward-compat section
of [pack-authoring.md](pack-authoring.md).

## MCP

Three read-only tools (added to `ALL_TOOLS` and audit catalog):
- `list_registration_hints`
- `get_registration_hint`
- `preview_registration_hint`

No write tool. Preview is purely informational.

## Template metadata

Templates can declare which hints apply via
`metadata.registrationHintIds`. Self-config doctor cross-checks that the
referenced ids resolve; missing ids surface as
`template-registration-hint-missing`.

## Safety

- Hints are static data — no executable pack code.
- Operations are declarative; engine substitutes `{{var}}` placeholders.
- Engine never auto-applies a hint.
- Ambiguous discovery is reported, never guessed.
- `requiresHumanReview: true` is the default for any hint that uses
  `targetGlobs`.

## Schemas

- Registry: `sharkcraft.registration-hint-registry/v1`.
- Preview: `sharkcraft.registration-hint-preview/v1`.
