# Scaffold patterns

A **scaffold pattern** is a pack contribution that says "when you see a
file matching this path/shape, suggest this template id with these
variables." Inference uses patterns to seed `infer templates` /
`onboard --scaffold-templates --ast` with high-confidence candidates
without re-implementing matching locally.

Patterns are **data**. The inspector layer interprets them — they cannot
run shell, evaluate code, or touch the network.

## Contributing patterns from a pack

Add a `scaffoldPatternFiles[]` entry to your pack manifest:

```ts
import { definePackManifest } from '@shrkcrft/plugin-api';

export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: { name: '@your-org/pack', version: '0.1.0' },
  contributions: {
    scaffoldPatternFiles: ['./src/assets/scaffold-patterns.ts'],
    // …
  },
});
```

Then default-export an array of patterns from that file:

```ts
import { defineScaffoldPatterns } from '@shrkcrft/plugin-api';

export default defineScaffoldPatterns([
  {
    id: 'app.service-contract-pattern',
    title: 'Service contract scaffold',
    description: 'Detects service contracts and maps them to app.service-contract.',
    matchPaths: ['packages/app/src/contracts/**/*.ts'],
    templateId: 'app.service-contract',
    variables: [
      { name: 'name', from: 'filename.kebab' },
      { name: 'pascal', from: 'className.stripPrefix:I' },
    ],
    appliesWhen: ['onboard', 'infer-template', 'create-service'],
    confidence: 'high',
    tags: ['app', 'service'],
  },
]);
```

## Variable extraction strategies

| Strategy                       | Source                                                           |
|--------------------------------|------------------------------------------------------------------|
| `filename.kebab`               | basename in kebab-case (`user-profile`)                          |
| `filename.pascal`              | basename in PascalCase (`UserProfile`)                           |
| `filename.stripSuffix:<S>`     | raw basename with `<S>` removed from the end (`user-profile.service` − `.service` → `user-profile`) |
| `className`                    | PascalCase of basename (alias for `filename.pascal`)             |
| `className.stripPrefix:<P>`    | PascalCase basename with `<P>` stripped (e.g. `I` from `IUserService`)|
| `className.stripSuffix:<S>`    | PascalCase basename with `<S>` removed from the end (`UserProfileService` − `Service` → `UserProfile`) |
| `functionName`                 | camelCase of basename                                            |
| `directoryName`                | name of the file's parent directory                              |
| `directoryName.kebab`          | parent directory in kebab-case (`UserProfile/` → `user-profile`) |
| `directoryName.pascal`         | parent directory in PascalCase (`user-profile/` → `UserProfile`) |
| `nearestPackageName`           | nearest `package.json` `name` field                              |

The table is ONE authority: `resolveScaffoldStrategy` (`@shrkcrft/plugin-api`)
implements every strategy, `isRecognizedScaffoldStrategy(s)` is
`resolveScaffoldStrategy(s, sample).recognized`, and the inspector's variable
extractor calls it directly — "recognised" and "implemented" cannot drift
apart. A suffix equal to the whole name is never stripped to nothing.

## CLI

```bash
shrk scaffolds list           # every pattern with id, template, source
shrk scaffolds get <id>       # full pattern + match paths + variables
shrk scaffolds doctor         # validate (template exists, strategies recognized, …)
shrk infer templates --ast    # candidates using patterns first, AST second
```

## MCP

```jsonc
// list_scaffold_patterns        — every loaded pattern (read-only)
// get_scaffold_pattern          — one pattern by id
// get_scaffold_pattern_doctor   — validation issues + next CLI command
```

All three are read-only. They never load pack code with side effects.

## Doctor rules

`shrk scaffolds doctor` errors when:

- `id` is missing/empty
- `templateId` doesn't resolve to a known template
- `confidence` isn't one of `high|medium|low`
- `matchPaths` contains an empty entry (round 13: an entry that is neither a
  string nor a well-formed `{ pattern, expectEmpty: true }` marker is REFUSED by
  the loader — a rejected entry — instead of loading as the glob `[object Object]`)
- a variable's `from` strategy is unrecognized

Doctor warns when `title` or `description` is missing, when `appliesWhen`
is empty (the pattern will never be consulted), and when a `templateId`
isn't registered in the active project.

### Dead selectors (round 11)

The doctor also walks the project ONCE — with `enumerateScaffoldPatternCandidates`,
the same walker `infer templates` attributes candidates with — and counts the
files each `matchPaths` glob matches (the pattern's own glob dialect):

- `matchPaths-matched-nothing` (warning) — per glob matching no file, even
  when a sibling glob matches;
- `pattern-dead` (warning) — a pattern matching no file after `excludePaths`.

`--json` adds `dead`, `patternCoverage` (`[{ patternId, files, perMatchPath }]`),
`coverage` and `deadUnits`. Exit: 1 on errors (warnings with `--strict`, dead
units with `--fail-on-dead-units`), 2 when any glob or pattern matched no file
or no pattern is declared at all (nothing was verified — `--allow-empty`
accepts that, and the acceptance is printed), else 0. The self-config doctor reports the same dead units
(`scaffold-pattern-*`).

### Intended-empty `matchPaths` (round 13)

A pattern for a path no file lives at yet marks the glob
([intended-empty.md](intended-empty.md)):

```ts
matchPaths: ['src/features/*/feature.ts', { pattern: 'src/plugins/*/plugin.ts', expectEmpty: true, reason: 'plugins land in v2' }],
```

- The loader normalises the marker to the plain glob plus the pattern's
  `expectEmptyUnits` ledger (stamped with the contributing pack); a malformed
  marker is a rejected entry (`matchPaths[<i>]: …`, exit 1 on `scaffolds
  doctor`, the round-12 channel everywhere else).
- While the marked glob matches nothing it is **intended-empty**: a
  `matchPaths-intended-empty` info finding and a printed acceptance
  (`scaffold patterns: accepted by expectEmpty: …`). The derived pattern-level
  unit ("matches no file after excludePaths") is left out when EVERY glob of the
  pattern is intended-empty, so one planned path is ONE acceptance — not the two
  dead units (`dead: 2`) an unmarked planned glob costs. A marked glob beside a
  dead sibling keeps the pattern judged.
- Once a file matches, the glob **went live** (`matchPaths-went-live`, info): the
  ✓ is withheld, the exit unchanged, `--fail-on-dead-units` fails a LOCAL stale
  marker (1), a pack's is INFO and never fails.
- `--json` adds `units: { dead, intendedEmpty, wentLive }`.

`scaffolds doctor` and MCP `get_scaffold_pattern_doctor` read ONE report
(`buildScaffoldPatternDoctorReport`) and propose through ONE rule
(`assetDoctorProposedExit`), so they agree: the MCP tool now carries the
patterns the loader refused (`rejected`, each an error) and the settled
`verdict` / `exitCode` / `shortfalls` / `accepted` (it used to drop refused
patterns and return no verdict).

## Safety

- Patterns are pure data — they cannot run shell commands.
- Inference uses dynamic `import()` of pattern files (local file only, no
  network).
- `--trusted-load` in `shrk packs test` evaluates pack code but still
  doesn't run shell.
- The inspector layer interprets `matchPaths` via a tiny glob compiler;
  no `minimatch` dependency.

## Local scaffold patterns (R29)

R29 extends the loader to read a local `sharkcraft/scaffold-patterns.ts`
file (was pack-only). The SharkCraft engine repo ships 8 self-patterns
that describe how to add a new piece of engine surface (CLI command,
MCP tool, inspector module, command catalog entry, JSON schema export,
docs page, policy, decision). See `sharkcraft/scaffold-patterns.ts` for
the canonical list.

Loader order: local file first, pack contributions after — a duplicate
id from a pack is REFUSED (a `duplicate-id` rejected entry) so local wins.

## Required fields and rejected patterns (round 12)

A pattern needs a non-empty `id`, a `templateId`, a non-empty `matchPaths`
and a `confidence` of `high` / `medium` / `low`. `confidence` used to be
checked only by `shrk scaffolds doctor`, so a pattern without one was ACCEPTED
and crashed `shrk scaffolds list`. A pattern failing any of them is a REJECTED
entry with every reason: `scaffolds list` ends with `⚠ N entries rejected from
<file>: 'sp.bad' (default[1]) — templateId: …; confidence: … → shrk scaffolds
doctor` (the raw `! …` warning strings are gone; `--json` adds `rejected`),
`scaffolds doctor` counts each as an error (`Rejected entries` block, exit 1),
and `shrk self-config doctor` reports `scaffold-pattern-invalid`. A missing
`variables` list is normalised to `[]`.
