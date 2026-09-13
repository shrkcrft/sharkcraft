# Reuse (intent → the canonical primitive)

The single most-violated convention in many large codebases is *"reuse the
existing primitive instead of re-implementing it."* It's also the hardest one
for an agent to satisfy by `grep`: the symbol name it needs isn't in a barrel's
text (a barrel is `export *`), and deep utilities sit many directories down,
effectively ungreppable.

`shrk reuse "<intent>"` closes that gap. It ranks two kinds of candidate:

- **Curated** — the canonical primitives a project declares as data in
  `sharkcraft.config.ts` `reusePrimitives[]`, keyed by role/intent.
- **Uncurated** — with a code graph, every construct on a workspace package's
  **public export surface** (reachable from the package's root entry, through
  barrel re-exports). Always labelled `uncurated`: nobody vouched for it.

Each answer is resolved through the **code graph** to its real declaration, its
**sibling exports**, a copy-pasteable **import line**, and real **consumer
files to copy**. Deterministic; no AI.

## Configuring primitives

```ts
export default defineSharkCraftConfig({
  reusePrimitives: [
    {
      symbol: 'Button',                       // the canonical exported symbol
      roles: ['button', 'clickable control'], // intent labels matched against the query
      importPath: '@scope/ui',                // the public specifier consumers should import from
      description: 'The shared button — variants, sizes, a11y built in.',
      keywords: ['cta', 'submit'],            // optional, widens matching
      supersedes: ['LegacyButton'],           // optional: "use me instead of these exports"
    },
  ],
});
```

| field | meaning |
|---|---|
| `symbol` | the canonical exported symbol to reuse (resolved in the graph) |
| `roles` | intent labels; `shrk reuse "<intent>"` matches query tokens against these (+ `keywords`, `symbol`, `description`) |
| `importPath` | the public import specifier (barrel/package entry). The source of the curated copy-paste `import` line. When omitted, `reuse` shows the declaration site + a re-exporting barrel hint (it never emits a deep-file import) |
| `description` | one-line "when to reach for this" |
| `keywords` | extra free-text terms to improve matching |
| `supersedes` | exported names this primitive deliberately REPLACES. They are never offered as uncurated candidates (they appear under `superseded` instead), and `shrk reuse coverage` does not count them as curation gaps |

Packs can ship primitives too (`reusePrimitiveFiles`, see [packs.md](packs.md)),
including `supersedes`.

## Running it

```bash
shrk reuse "I want to add a button"     # ranked candidates + import + consumers
shrk reuse "date formatting" --limit 1  # cap the number of matches (default 3)
shrk reuse "<intent>" --curated-only    # reusePrimitives[] only — the pre-round-11 ranking
shrk reuse "<intent>" --include-types   # also consider interfaces / type aliases
shrk reuse "<intent>" --json            # machine-readable (schema: sharkcraft.reuse/v1)
shrk reuse coverage                     # curated index vs the public surface (below)
```

Output per match: a label (`[curated · …]` or `[uncurated · exported by <pkg> ·
exact name match]`), the import line, where it's declared, the barrel chain it
is reached through (uncurated), its sibling exports, and a few real consumer
files you can copy from. With no confident match it prints a short
*did-you-mean* list; the full catalog of declared roles appears only with
`--all`.

An empty intent is a usage error (exit `3`). Because `shrk reuse coverage` is a
verb, the single-word intent `coverage` is not reachable — add a word
(`shrk reuse "coverage chart"`). Multi-word intents are unaffected.

## The uncurated export-surface fallback

A curated index covers what someone remembered to curate. The rest of the
workspace's public API is still there, and `reuse` now reads it:

- **The surface** is enumerated by the code graph
  (`GraphQueryApi.publicExportSurface()`, see
  [code-intelligence.md](code-intelligence.md)). Each root is the file a bare
  `import … from '<package>'` resolves to — the same resolver every consumer
  import goes through — and names are followed through `export *` / `export {
  A as B }` chains with the same resolver `graph callers` uses. ESM semantics:
  `export *` never forwards a default export.
- **The import line is real.** An uncurated answer's `importPath` is the package
  name, and the construct is reachable from that package's root entry, so
  `import { X } from '<package>'` compiles — or `import X from '<package>'` for
  the package's DEFAULT export (`importStyle: "default"`). Nothing is derived
  from a deep path. A curated row's import line comes from the same resolver
  `shrk reuse coverage` checks it with (below), so the two cannot disagree.
- **Namespace re-exports** (`export * as ns from './x'`) are on the surface as
  one export (`declKind: "namespace"`, `declaredIn` = the module it binds).
- **Loud skip.** Without a graph index the surface is NOT searched, and the
  output says so (`⚠ uncurated export surface NOT searched (no graph index)`;
  `--json`: `exportSurface.status: "not-searched"`). The same status, with its
  reason, when no package entry resolves to an indexed file or there are no
  workspace packages — zero roots walked is never `searched`. `partial` when
  some packages have no resolved entry or a local re-export could not be
  followed. A package the index cannot root (no resolvable entry, or an index
  built before round 11 — re-run `shrk graph index`) is listed with its reason,
  never dropped; so is every re-export that lands on no indexed declaration
  (`unfollowedReExports`: `unresolved` = a local module or name, part of the
  surface NOT searched; `external` = a module outside the workspace).
- **On the miss path** (nothing matched by name) `reuse` also reports when the
  index is behind the working tree, so a construct you just wrote is not
  mistaken for one that does not exist.

Excluded from the uncurated pool: constructs already curated (the curated
entry's resolved DECLARATION — a same-named export of a different construct in
another package stays a candidate), names a curated entry `supersedes`,
type-level exports (interfaces, type aliases) unless `--include-types`, and
test files.

**Known limit:** package.json `exports` subpath maps are not walked — only the
package's root entry (the same file the consumer edges point at), and only
workspace packages (package.json `workspaces`).

## Ranking

Candidates are ranked in tiers; within a tier by score, then the closer name
(fewer extra name tokens), then symbol, then declaring file.

| tier | candidate |
|---|---|
| 1 | curated, and its NAME answers the intent (**exact** / **covers**) |
| 2 | uncurated, **exact** name match |
| 3 | uncurated, the name **covers** every intent token |
| 4 | curated, its name matches only **part** of the intent, or it matched only through roles / keywords / description |

So a curated `AppButton` still beats an uncurated `Button` for "button"
(curation that names the construct stays authoritative), while an exactly-named
`DateRangePicker` beats a generic `Popover` whose keywords happen to say "date",
"range" and "picker" — and beats a curated `RangeSlider` that shares only
"range". An uncurated **partial** name match is never an answer; it is offered
as a did-you-mean only when nothing else is.

## Match confidence

`reuse` won't dress up a weak guess as an answer.

- **Name matching is token equality**, on identifiers split by the one shared
  splitter (`DateRangePicker` → date, range, picker): `ran` does not match
  `DateRangePicker`. The intent is split the same way, so typing the identifier
  itself is an exact match. Roles, keywords and description are still matched
  by containment; they move to token overlap with the shared normaliser of
  round-11 §2.5, for reuse and the recommender together.
- A **lone weak keyword collision** (a single non-name token hitting on a
  multi-token intent) is not a confident match: the command prints `No confident
  match` plus a did-you-mean list (`--json`: `suggestions` and the legacy alias
  `didYouMean`).
- Every result says **where it matched**: `matchedVia` (`symbol` / `role` /
  `keyword` / `description`) and `nameMatch` (`exact` / `covers` / `partial` /
  `none`). A curated hit earned only through metadata is labelled in text:
  `score 3 (100% of intent — via keywords, description; not its name; …)`. The
  numeric `confidence` keeps its meaning (the fraction of intent tokens
  matched).
- `curationGap: true` when an uncurated export answers by name (exact / covers)
  while the best curated candidate names only part of the intent, or matched
  only through metadata — the curated index does not cover this intent. It is
  the same predicate (`isReuseCurationGap`) `shrk reuse coverage` lists
  `shadowed` by. The text output ends with a pointer to `reusePrimitives[]`,
  `supersedes`, and `shrk reuse coverage`.
- The shared confidence vocabulary (the same keys `recommend` and playbooks
  use): `confident` (boolean), `verdict` (`confident` / `no-confident-match` /
  `no-match`), `floor` (the distinct intent tokens a metadata-only match must hit
  — 2, or 1 for a single-token intent; a name match always clears it) and
  `bestScore`.

`--json` additions (all additive): per result `source`, `nameMatch`,
`matchedVia`, `importStyle` (`named` / `default`; `isDefault` for a default
export), for curated rows `importPathAgrees` when the graph could check it
(`false` also prints a ⚠ under the import line), and for uncurated rows
`package` and `via`; top level `exportSurface {status:
searched|partial|not-searched|disabled, reason?, roots, packagesWithoutEntry,
size, unresolvedReExports?, unfollowedReExports?}`, `curationGap`,
`superseded`, and `indexBehind` on the miss path (it also names workspace
packages whose entry changed since the index). `--curated-only` still emits
`matchedVia` / `nameMatch`.

## `shrk reuse coverage`

Curation drift, measured: the curated index against the real public surface.

```bash
shrk reuse coverage                         # headline + findings
shrk reuse coverage --json                  # sharkcraft.reuse-coverage/v1 + the shared gate envelope
shrk reuse coverage --min-coverage 20       # fail below 20% of value exports curated
shrk reuse coverage --package @scope/ui     # narrow to some packages (deliberate; not a gap)
shrk reuse coverage --include-types --all   # count types; list every uncovered export
```

The headline puts the disconfirming numbers on one line:

```
curated 1 · public exports 5 (value 4) · coverage 1/4 value (25%) · 0 package(s) without a resolved entry
```

Each curated entry gets a status:

| status | meaning |
|---|---|
| `public` | on some package's public surface |
| `exported-not-public` | exported from its file, but no package entry reaches it |
| `not-exported` | declared, never exported |
| `not-found` | declared nowhere in the index — a **dead entry** every `reuse` answer still recommends |
| `ambiguous` | several exported declarations, none public |

plus `importPathAgrees` when `importPath` is set: does the module it names
expose the symbol (would the printed import compile)? A package-name importPath
is checked against that package's surface; any other specifier against the file
consumers' imports of it resolved to, walked with the same ESM export walk.
`importStyle` / `importLine` are the exact import `shrk reuse` prints — one
resolver (`resolveCuratedReuse`) decides the entry's declaration, its import
line (a default import for a default export) and whether that compiles, for
both verbs. Only the construct the entry names counts as public (`publicIn`): a
same-named export of a different construct is not this entry, and stays in
`uncovered`.

**Curation gaps** (`shadowed`): an uncovered public export whose own name, asked
as an intent, gets a curated answer that names it only in part or not at all.
It is computed with the lookup's own ranker and gap predicate, so `e ∈
shadowed` exactly when `shrk reuse "<its words>"` reports `curationGap`.

The exit-0 sentence is built from the report: `Every curated reuse entry
resolves on the public surface. ✓` only when every in-scope curated entry is
public and nothing advisory was found; otherwise `No blocking reuse coverage
problems — <N curation gap(s), N curated entries not on the public surface>
(listed above).`, or `No curated reusePrimitives[] — 0 of N value export(s)
curated.` — never a vacuous ✓.

Exit codes:

| exit | when |
|---|---|
| `0` | measured, nothing blocking (curation gaps and curated entries no package root exposes are warnings) |
| `1` | a `not-found` curated entry · an `importPath` that does not expose its symbol · `--min-coverage` unmet · `--strict` with any warning |
| `2` | NOT VERIFIED — no graph index · a stale index (any file changed since it was built, OR a workspace package whose entry changed — a package.json `main`/`module`/`types` edit, the `workspaces` list, a package added or removed — `packagesChanged` in `--json`; no number or percentage is printed; re-run `shrk graph index`) · a workspace package with no resolved entry, or one whose walk met a LOCAL re-export the index could not follow (its exports were not fully measured; narrow with `--package`) · nothing to measure (no curated entry and no public export; `--allow-empty` accepts that explicitly) |
| `3` | usage — a stray positional, an unknown flag, a bad `--min-coverage`, an unknown `--package`, an unloadable config |

`--json` carries the shared `gate` envelope ([gate-json.md](gate-json.md)) with
one rule of type `reuse` per curated entry (counts `{public, consumers}`;
violations for a dead entry, an importPath mismatch, and each curation gap it
answers), plus a `min-coverage` rule when that flag is given. `gate.exit` is the
process exit.

## Requirements & behavior

- **Build the code graph first** (`shrk graph index`) for the export-surface
  fallback, import-path resolution, siblings, and consumers. Without it,
  `reuse` still returns the configured symbol + `importPath` (from config), and
  says the surface was not searched. An index built before round 11 has no
  package `entryFile`: re-index.
- Consumers are resolved via graph references — including `new`/type/DI usage,
  not just call expressions — so "copy a real consumer" works even for classes
  that are never *called*.
- The engine (`rankReuseCandidates`, `computeReuseCoverage` in
  `@shrkcrft/inspector`) is pure: the surface is injected by the caller, so a
  read-only MCP tool can call it without the inspector importing the graph.
- The registry is generic: shrk hard-codes no symbol. Keep `reusePrimitives[]`
  focused on the primitives most worth reusing, and let `shrk reuse coverage`
  tell you which exported names the index answers wrongly.
