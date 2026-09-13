# Pack authoring

A SharkCraft pack is a regular npm package whose `package.json` has a
`sharkcraft` section and which contributes `knowledge` / `rules` / `paths` /
`templates` / `pipelines` / `presets` (and optionally `boundaries`) through
its plugin entry.

> R52/R53 cross-links: the local authoring surface for these asset
> kinds — `shrk knowledge add|update|remove`, `shrk rules
> add|update|remove`, `shrk templates scaffold|update|remove` — lives
> in [knowledge-authoring.md](./knowledge-authoring.md). Editing
> pack-shipped assets still requires editing the pack source and
> re-signing the manifest (see
> [pack-signatures.md](./pack-signatures.md) for the dev-vs-release
> distinction). The unified
> [`shrk lint`](./lint.md) entry point aggregates the three per-kind
> doctors when you want a single triage pass across knowledge / rules
> / templates.

## Scaffolding

```bash
shrk packs new my-pack --kind framework --write
cd my-pack && npm install && npm run typecheck
shrk packs test          my-pack --load --typecheck
shrk packs release-check my-pack --typecheck
shrk packs sign          my-pack --secret "$SHARKCRAFT_PACK_SECRET"
```

`packs new` is **dry-run by default**; pass `--write` to materialize the
files. It refuses to overwrite an existing directory unless you pass
`--force`. The scaffolder never runs `npm install` and never publishes.

## Kinds

The `--kind` flag changes the seed content:

| Kind          | Use for                                                       |
|---------------|---------------------------------------------------------------|
| generic       | Minimal scaffold — knowledge + a placeholder rule             |
| framework     | Includes an example template/pipeline so consumers have a model |
| architecture  | Adds a `boundaries.ts` example for layer rules                |
| enterprise    | Adds review/security baseline docs and a stricter rule seed   |

You can combine `--with-examples` to attach the optional example files to
any kind.

## What gets generated

```
my-pack/
  package.json            # sharkcraft.manifest → ./src/sharkcraft.plugin.ts
  README.md
  SECURITY.md
  tsconfig.json           # strict, noEmit, allowImportingTsExtensions
  src/
    sharkcraft.plugin.ts  # `{ schema, info, contributions } satisfies ISharkCraftPackManifest`
    assets/
      knowledge.ts
      rules.ts
      paths.ts
      templates.ts        # framework / --with-examples
      pipelines.ts        # framework / --with-examples
      presets.ts          # --preset <id>
      boundaries.ts       # architecture / --with-examples
      docs/overview.md
```

The scaffold is a **valid, discoverable, type-clean** pack (round 11):

- `package.json` `sharkcraft.manifest` points at `src/sharkcraft.plugin.ts` —
  discovery reads nothing else; without it the pack is `INVALID`.
- That file default-exports a real manifest, and every asset the scaffold
  emits is declared in it. A file the manifest does not list is never loaded,
  so no empty, unlisted asset is emitted.
- Every asset is annotated with a **type-only** import and `satisfies`:

  ```ts
  import type { IKnowledgeEntry } from '@shrkcrft/plugin-api';
  export default [
    { id: 'pack.overview', title: 'Pack overview', type: 'technical', priority: 'medium',
      scope: [], tags: [], appliesWhen: ['onboarding'], content: '…' },
  ] satisfies readonly Omit<IKnowledgeEntry, 'source'>[];
  ```

  `import type` is erased at runtime, so the structural-arrays guarantee below
  still holds; `satisfies` makes a misspelled field, a missing required one, or
  a reference `kind` outside the union fail `npm run typecheck` where it is
  written. The SDK re-exports `IKnowledgeEntry`, `IKnowledgeReference`,
  `KnowledgeReferenceKind`, `ITemplateDefinition` and `ITemplateChange` as
  types for this.
- `scripts`: `typecheck` (`tsc -p tsconfig.json`), `test`
  (`shrk packs test . --load --typecheck`), `release-check`.

### Group modules

Split a large asset into group modules and re-export them from the file the
manifest lists — `export * from './group.ts'`. The loader collects every
entry-shaped export of a listed module, so nothing is named twice. A
hand-maintained array works too, but an entry added to a group and not to the
array is invisible to every lookup: `shrk doctor` / `shrk packs doctor`
report it as `unregistered-export` (error), naming the export and its line. A
second, DIFFERENT object reusing an id in one module is reported as
`duplicate id "<id>" … shadowed by an earlier export` (only the first
registers).

## Safety

- Packs never auto-run shell commands. Verification commands contributed by
  a pack are surfaced but not executed by `shrk apply --validate`. Only the
  locally-configured `sharkcraft.config.ts verificationCommands[]` is
  trusted as runnable.
- Packs may ship signed manifests. Sign with `shrk packs sign`, verify with
  `shrk packs verify`. Consumers can require signatures via
  `shrk packs doctor --require-signatures`.
- The CLI is the only write path; MCP tools are read-only.

## Pack contribution test

```bash
shrk packs test <path>                       # manifest + declared files (structural)
shrk packs test <path> --require-signature
shrk packs test <path> --load                # imports + validates exports
shrk packs test <path> --trusted-load        # also runs template renderers with default vars
shrk packs test <path> --typecheck           # type-checks the manifest + every TS contribution
```

`packs test` reads the manifest `package.json` points at
(`sharkcraft.manifest`) and checks every contribution file it declares — no
hard-coded asset list. A `package.json` with no `sharkcraft.manifest` is an
error (`no-manifest`): discovery would report the pack INVALID.

`--load` imports the manifest and every declared contribution module, asserts
the manifest validates, that each knowledge/rule/path/template/pipeline/
preset/boundary file exports an array, and that every item has a string
`id`. It also checks that pipelines declare steps.

**Round 12 (12.1c / 12.1f):** `--load` also runs, for EVERY declared slot,
the loader — or the acceptance predicate — the engine applies to it at
runtime (`validateContributionFile`). An entry it would refuse is an
`asset-entry-rejected` **error** (exit 1), annotated or not:

```
  ERROR    asset-entry-rejected         conventions.ts 'conv.b' (default[1]) — severity: severity must be one of: info, warning, error (got undefined) — the convention loader refuses it, so it would not take effect
  ↳ Annotate the asset with a type-only import and `satisfies IConvention[]` (from @shrkcrft/plugin-api) — see docs/pack-authoring.md — then `shrk packs test . --typecheck` catches this at build time.
```

`--typecheck` verifies only what an asset's own type annotations declare — a
bare `export default [ … ]` literal is structurally unconstrained, so tsc
passes it. Annotate the asset so the typecheck can fail it too:

```ts
import type { IConvention } from '@shrkcrft/plugin-api';

export default [
  { id: 'conv.a', title: 'A', kind: 'naming', severity: 'warning', rules: [] },
] satisfies IConvention[];
```

What only a consuming repository can decide — a duplicate across files or
packs, a construct facet's target construct, a gate-plane `$use` extractor —
is judged at load (`shrk packs contributions`), not by `packs test`.

**Round 15 (15.2):** `--load` also runs THE knowledge validator over the
entries a knowledge-bearing file's loader ACCEPTED: an issue that keeps the
entry — a non-list `references` value, a malformed reference item — is an
`asset-entry-invalid` issue at its severity (an error fails, exit 1), the same
issue the consumer's `shrk doctor` reports. A declared Markdown knowledge file
is data (never imported), but its loader reads it too, so frontmatter it would
refuse is an `asset-entry-rejected` error.

**Round 15 follow-up:** `--load` reads each file the way the consumer reads its
SLOT — never by its extension alone. A non-module file under a knowledge slot
(`knowledgeFiles` / `ruleFiles` / `pathFiles` / `pathConventionFiles` /
`docsFiles`) goes to the knowledge loaders (Markdown), and counts as an
examined module — a pack of Markdown knowledge alone is no longer "no
importable contribution file" (NOT VERIFIED). One no knowledge loader reads
(`knowledgeFiles: ['./notes.txt']`) is an `asset-unsupported` **error**: the
consumer skips it as an unsupported contribution file, so nothing in it takes
effect. The knowledge loader's own test decides, never an importable-looking
name: a `.mts` / `.cts` module under a knowledge slot is `asset-unsupported`
too (the TypeScript knowledge loader reads `.ts`, `.tsx`, `.js`, `.mjs` and
`.cjs`). A file under any other slot is imported like its runtime loader imports
it — a `.md` under `templateFiles` is a template module that exports no
templates, never Markdown knowledge.

### Markdown knowledge and pack reference roots

A pack's Markdown knowledge (`knowledgeFiles` / `ruleFiles` / `pathFiles` /
`docsFiles`) declares references in a `references:` frontmatter list — the
same references a TypeScript entry declares (shapes and refusals:
[knowledge-integrity.md](./knowledge-integrity.md)). Without one, every
consumer's `shrk knowledge stale-check` counts the entry unverifiable (exit 2)
and names your pack as the place to fix it.

Pack references resolve against the CONSUMER's root by default: a `file:` /
`directory:` path joins the consuming project's root, and `package:` reads the
consumer's root `package.json` (its name and workspaces) — plus your pack's
OWN name, for your pack's entries (installed by definition). To verify a doc
against a file YOUR PACK ships, declare `root: pack` on the reference — a
Markdown map item (`- kind: file` / `path: docs/guide.md` / `root: pack`) or
`root: KnowledgeReferenceRoot.Pack` (@shrkcrft/core) in TypeScript: its path,
`contains` / `matches` and `count` source then resolve against your package
directory wherever the pack is installed, and each stale-check row names that
root. `root: pack` is valid only on a pack's entry — on a consumer's local
entry it is an error — and the compact string grammar (`file:docs/guide.md`)
carries no root. Id kinds — `template:`, `playbook:`, `construct:`, `helper:`,
`policy:`, `command:`, `boundary-rule:`, `path-convention:` — resolve wherever
the pack is installed. A consumer can accept the remainder explicitly with
`knowledgeCheck.minReferenced`. Details:
[knowledge-integrity.md](./knowledge-integrity.md) (Pack references and
`root: pack`).

`--typecheck` (round 11) runs the in-process TypeScript check
(`typecheckFiles`, the same one `gen --typecheck` uses) over the manifest and
every `.ts` contribution, with the pack's own `tsconfig.json` (strict
defaults otherwise). Each diagnostic in a file under the pack root is a
`typecheck-error` issue (`<file>:<line>:<col> TS<code> <message>`) → exit 1.
A pack with no TS file to check, or a run where TypeScript could not start,
examined nothing → exit **2** (`NOT VERIFIED`), never a pass. The same opt-in
`--typecheck` exists on `packs doctor` (per discovered pack) and
`packs release-check` (finding `typecheck-error`). Pack loading itself stays
transpile-only: the typecheck is costly and never part of default loading.

`--trusted-load` additionally runs each template's `targetPath()` and
`content()` with synthesized default variables — useful for catching
renderers that throw when fed unexpected inputs. As the flag name says:
this evaluates pack code. Only run it on packs you trust.

Safety: even with `--trusted-load`, SharkCraft does not execute pack shell
commands, does not run lifecycle scripts, and does not touch the network.
The loader uses dynamic `import()` of local files only.

Direct TypeScript loading requires Bun. Under Node, `--load` reports the
limitation as a warning and falls back to the structural-only path.

### Pack test cases (`definePackTest`)

| Ranker-surfaced (order-sensitive) | Registry existence (stable) |
|---|---|
| `expectKnowledgeIds`, `expectRuleIds`, `expectTemplateIds`, `expectPipelineIds`, `mustNotIncludeIds` | `expectPlaybookIds`, `expectConstructIds` |

A surfaced-class miss is `unknown-id` (not registered — can never pass) or
`not-surfaced` (registered, not in the packet); each names the registry it
consulted (`consulted: { kind, listVerb, size }`). `expectPlaybookIds` /
`expectConstructIds` are existence checks through the shared reference
registry — before round 11 they were declared but never evaluated, so a typo'd
id passed silently.

## Release check (R13 / R14)

```bash
shrk packs release-check <path-to-pack> [--json]
shrk packs doctor --release [--require-signatures] [--strict] [--json]   # R14
```

`packs release-check` runs every check a release reviewer would want
to see, with a single exit code:

- `package.json` exists and points at a signed manifest.
- Manifest passes `validatePackManifest`.
- Every contribution file actually exists.
- Every contribution file imports cleanly (`*.ts` / `*.js` / `*.mjs` / `*.cjs`).
- The manifest has a HMAC signature (warning when absent).
- `package.json` `files[]` covers the signed manifest.

R14 ergonomics: each finding now includes `code`, `severity`, `file`,
`message`, an optional `suggestedFix`, and an optional copy-pasteable
`suggestedCommand` (for example, `shrk packs sign … --verify-after-sign`
for an unsigned manifest, or `shrk packs compat <path>` for helper-missing
import errors).

Use `shrk packs release-check` as the last gate before tagging. MCP
exposes the same payload via `get_pack_release_check`.

`shrk packs doctor --release` folds these findings into the existing
doctor report. New issue codes:

- `release-manifest-issue`
- `release-contribution-issue`
- `release-signature-issue`
- `release-files-issue`
- `release-readiness-issue`

`--strict` escalates release-check warnings into errors so a single
green/red gate covers the whole pre-tag readiness story. MCP exposes
the merged report via `get_pack_doctor_release`.

## Structural exports for backwards compatibility (R14)

When a pack imports a helper like `defineScaffoldPatterns` from
`@shrkcrft/plugin-api`, the helper must be present in the version of
`@shrkcrft/plugin-api` the consumer has installed. If a consumer's
pinned version pre-dates the helper, the contribution fails to load with
"`Export named 'X' not found in module '@shrkcrft/plugin-api'`".

R14 surfaces this as a `contribution-helper-missing` finding with three
fix options:

1. Bump `@shrkcrft/plugin-api` to a version that ships the helper.
2. Declare a `peerDependencies."@shrkcrft/plugin-api"` range that
   includes the helper.
3. Drop the helper import and ship a plain `export default ([...])`
   structural array. SharkCraft loads pack contributions by reading the
   default export, so structural arrays work against every plugin-api
   version.

`shrk packs compat <path>` reads the pack with the current
`@shrkcrft/plugin-api` and reports helper-missing diagnostics with the
same suggested-fix shape — useful as a quick "will this pack load on a
6-month-old consumer?" check.

### Plugin-api symbol diff (R15)

```bash
shrk packs compat <path-to-pack> --consumer-root <path>
shrk packs compat <path-to-pack> --consumer-root <path> --json
```

R15 extends `packs compat` with a symbol-level diff:

1. Walks the pack's contribution files and extracts every named import
   from `@shrkcrft/plugin-api`.
2. Resolves the consumer's installed `@shrkcrft/plugin-api` (or the
   pack's own `node_modules` copy as a fallback).
3. Collects the consumer's exported symbols by scanning the source /
   `dist/*.d.ts` / `dist/*.js`.
4. Reports each imported symbol as `available` or `missing`.

When `missing` symbols are found, the suggested-fix block lists four
options:

1. Bump `@shrkcrft/plugin-api` in the consumer workspace.
2. Widen `peerDependencies."@shrkcrft/plugin-api"` only if the symbols
   are stable across the range.
3. Replace the helper imports with plain structural object literals.
4. Drop the helper import entirely if the contributions no longer need it.

MCP: `get_pack_compat_report` returns the same payload server-side.

## `expectEmpty` markers: forward-compat (round 13)

Round 13 lets a list entry say "this target does not exist yet" — `{ pattern,
expectEmpty: true, reason? }`, or `{ weight, expectEmpty: true, reason? }` for a
search-tuning boost value — on boundary rules, the gate planes, and the assets
a pack ships: registration hints (`discovery.targetGlobs` /
`discovery.targetFile`), scaffold patterns (`matchPaths`) and search tuning
(`boostIds` / `taskHints[].boostIds`). A pre-emptive entry is the main pack use
case: a framework pack names the binding, the route table or the guide only
adopting apps will have. See [intended-empty.md](intended-empty.md).

**Markers need engine 0.1.0-alpha.31 or later.** There is no manifest field
declaring a minimum engine yet, and an older engine does NOT refuse the object
form loudly for every kind. What 0.1.0-alpha.30 does with a marker in an asset
file:

| Where the marker is | 0.1.0-alpha.30 |
|---|---|
| a registration hint's `discovery.targetGlobs` entry | the hint LOADS (its validator checks only that the list is non-empty), then `registrations doctor` and `self-config doctor` crash: `glob.includes is not a function` |
| a scaffold pattern's `matchPaths` entry | it loads as the glob `[object Object]`, which matches nothing — silently |
| a search-tuning boost value | it loads, silently clamped to 0 (an info `boost-clamped` only) |

Gate-plane config validates its lists as strings, so an object entry there
fails validation instead (a local config load error; a pack's gate-plane element
is dropped with a diagnostic). Boundary rules do NOT: the 0.1.0-alpha.30
validator checks only that `from` / `forbiddenImports` / `allowedImports` are
arrays, so a boundary rule carrying a marker LOADS and the object entry matches
nothing — a fence that silently never fires. Ship markers only in a pack
release that requires this engine (say so in your README and in
`peerDependencies`), or keep the entry plain until your consumers upgrade — a
plain planned entry reads as a dead unit (exit 2 on the asset doctors), never as
a crash.

From 0.1.0-alpha.31 on, every loader refuses what it cannot read LOUDLY,
through the round-12 rejection channel (`packs contributions`, `packs list`,
`packs test --load`, each doctor): an entry that is neither a string nor a
well-formed marker, a boost value that is neither a number nor a well-formed
marker, a marker on a search-tuning key that can never fire, and an authored
`expectEmptyUnits` (the loader derives that ledger). Never a crash, never a
silent clamp. `shrk packs test <path> --load` runs the same acceptance
predicates, so the pack's own CI catches a malformed marker before release.

A pack's marker is stamped with the pack. When the consumer's target appears it
reads **went-live** as INFO and never fails the consumer — not under
`--fail-on-dead-units`, not under `--strict` — because the consumer cannot edit
it. Remove it in your next release.
