# Conventions (R33)

Naming / path / barrel / layout / command / validation / ownership /
testing / release / safety conventions contributed by packs or local
`sharkcraft/conventions.ts`. The engine ships zero conventions; every
entry comes from a contribution.

## Commands

```bash
shrk conventions list [--kind <kind>] [--source local|pack]
shrk conventions get <id>
shrk conventions doctor [--strict] [--allow-empty] [--json]
shrk conventions check [--files a,b,c] [--since <ref>] [--staged] [--allow-empty] [--json]
shrk conventions explain <id>
```

`conventions doctor` settles against the convention FILES it read: `0` · `1` an
invalid convention (or a `convention-shape` warning under `--strict`) · `2` a
convention file that is missing or failed to load (its conventions were never
validated), or no convention file at all — `--allow-empty` accepts only the
latter. `--json` carries `files`, `coverage`, `exitCode`, `verdict` and
`shortfalls`.

`conventions check` is a verdict verb (round 13), settled through the shared
gate envelope (`--json` carries `gate`, `exitCode`, `shortfalls`, `accepted`
next to the engine's own `schema` / `filesScanned` / `hits`; the top-level
`verdict` is the engine's `clean` / `has-violations`, `not-verified` at `2` and
`has-violations` at any `1` — never `clean` beside a failing or NOT VERIFIED exit):

| Exit | When |
|---|---|
| `0` | every file in scope checked against every loaded convention, no `error`-severity hit (warning / info hits are listed, never failing) |
| `1` | an `error`-severity hit, or a convention the loader **rejected** (an ERRORED row — it was never evaluated; see below) |
| `2` NOT VERIFIED | nothing to check: **no file in scope** (no working-tree change, an empty `--since` / `--staged` diff), **no convention declared**, or a **convention file that never loaded** (its conventions were never checked) |
| `3` | a usage error — an unknown flag (`--bogus`). `--strict` is not one here: it is the global promoter, turning a `2` into a `1` |

`--allow-empty` accepts the first two explicitly — the acceptance is printed,
never silent — and never the third: an unread convention file is a file with
conventions nobody checked. Before round 13 an empty scope printed `ok — no
violations.` at exit `0`, which read like a pass over nothing.

### Where a convention applies — `appliesTo` (round 15)

Every `appliesTo` filter scopes the convention. Before round 15 only `fileGlobs`
did: `profileIds`, `frameworks` and `languages` were validated (the doctor even
resolved `profileIds`) and then ignored, so a convention restricted to a
workspace shape the repo does not have applied exactly as if unrestricted.

ONE authority decides it — `conventionApplicability(convention, inspection,
file?)` (`@shrkcrft/inspector`) — for `conventions check`, the rule-graph bridge
(`rule-graph for <file>`), MCP `prepare_agent_task` and the `list` / `get` /
`explain` display. Semantics (the pack-compatibility precedent):

- within a filter, **any** listed value matches;
- **every** declared filter must match;
- an absent or empty filter imposes no constraint.

| Filter | Level | Matches when |
|---|---|---|
| `profileIds` | workspace | a listed id is a DETECTED WorkspaceProfile (`shrk profiles list --kind workspace` marks `detected`) |
| `frameworks` | workspace | a listed id is a detected framework — the `FrameworkId` vocabulary of `@shrkcrft/workspace`: `angular`, `react`, `vue`, `svelte`, `nextjs`, `nuxt`, `nestjs`, `express`, `fastify`, `nx`, `aws-lambda`, `electron`, `typescript`, `bun` |
| `languages` | per file | the file's language, by extension, is listed — the vocabulary `shrk stats` prints (`typescript` for `.ts/.tsx/.mts/.cts`, `javascript`, `python`, …) |
| `fileGlobs` | per file | the glob list selects the project-relative path — `**` spans zero or more segments (`src/**/*.ts` matches `src/a.ts`), `?` is one character but never `/`, a `!` entry SUBTRACTS (`['src/**', '!src/gen/**']`) |
| `constructKinds` | — | RESERVED, never evaluated: there is no deterministic file → construct-kind authority. The loader warns (`appliesTo.constructKinds is reserved and not evaluated — the convention applies regardless`, a `convention-shape` warning — `conventions doctor --strict` fails on it) |

An `appliesTo` key outside these five is an **error** with a did-you-mean
(`appliesTo.fileGlob is not an appliesTo filter … did you mean "fileGlobs"?`):
the convention is rejected through the round-12 channel, because a typo'd
filter silently widened the convention to every file. A malformed `fileGlobs`
list — a bare `!`, `!!x`, negations only — is an error too, as on every gate
plane. The self-config doctor reports a `frameworks` / `languages` value outside
its vocabulary as an info `convention-framework-missing` /
`convention-language-missing` finding (with a did-you-mean: `next` → `nextjs`,
`ts` → `typescript`), like `convention-profile-missing`.

**Not applicable is printed, never silent.** In `conventions check` a
convention whose workspace filters exclude this repo — or whose per-file
filters select none of the files in scope — is NOT evaluated. It is printed
with its reasons in every exit:

```
=== Convention check (1 files, 0 hits, 1 not applicable) ===
  n/a     c.turbo — not applicable: appliesTo.profileIds [has-turborepo]: none detected (detected: has-typescript)

ok — no violations among the 1 applicable convention(s); 1 not applicable (listed above).
  c.turbo: accepted by appliesTo: examined 0 of 1 conventions, 1 not applicable — appliesTo.profileIds …
```

`--json` carries `notApplicable[]` (`{ conventionId, severity, sourceFile,
packageName?, reasons[] }`, each reason `{ filter, level, declared, observed,
matched, message }`), `filesInScope` (per applicable convention) and
`applicable` (the count evaluated). In the `gate` envelope a not-applicable
convention's row is `skipped` with `skipReason: "not applicable — …"` and
coverage `{ unit: "conventions", expected: 1, examined: 0, acceptedBy:
"appliesTo" }` — an explicit acceptance, so one passing convention beside a
not-applicable one exits `0`, and `evaluated` never counts it. When
conventions loaded and NONE applies, nothing checked the files: the RUN-level
`applicable conventions` record (`gate.runRecords`, expected = the applicable
count) makes that `2` NOT VERIFIED, and `--allow-empty` accepts it explicitly.
It is a run record, not a row (round 15 follow-up): as a pseudo-row in
`gate.rules` it was counted in `gate.evaluated` as if it were a convention that
ran.

**A rejected convention is an ERRORED row (round 15 follow-up).** A convention
its loader refused (a missing `severity`, an unknown `appliesTo` key, …) never
runs. `conventions check` prints it —
`error   convention rejected at load — NOT evaluated: 'c.bad' (default[1]) — severity: … (sharkcraft/conventions.ts)`,
prefixed `pack <name>` for a pack's — as a `gate.rules` row with `status:
"error"`, and exits `1`. Before, it vanished and the run printed `ok — no
violations.` at `0` (the seam-rejected gate-rule precedent). `--json`
`rejected[]` carries every refused declaration (`{ entryId?, file, index,
exportName?, packageName?, cause, reasons[] }`); a `duplicate-id` one is printed
as a note and is not a row — the declaration it collided with runs. There is
one row per refused DECLARATION (file, export, index), never one per id: two
invalid `c.bad` declarations — a local one and a pack's — are two rows, and the
`N rejected` count matches `rejected[]`. A row id is unique in `gate.rules`: a
refused id that a loaded convention (or an earlier refused declaration) already
holds is qualified by its declaration site — `c.x
(node_modules/@p/x/conventions.ts[0])` — so its shortfall never reads as if the
convention that RAN was not evaluated.

**One spelling per file, realpath-canonical (round 15 follow-up).** Every file
in scope (`--files`, `--since`, `--staged`) is read project-relative with every
symlink resolved — the file's and the project root's — so a symlinked absolute
path (`/link/src/a.ts` with `/link` → the project, or macOS `/var/…` for a root
at `/private/var/…`) behaves exactly like its target. It read
`../link/src/a.ts`, which no `fileGlobs` selected, so the convention was
silently not applicable. A symlink whose target leaves the project keeps its
in-project spelling.

**`--since` / `--staged` read the project's own files (round 15 follow-up,
lane B).** git names a changed path from the repository TOP LEVEL; the changed
scope maps it to the project root (the root the inspection reads), so a
project nested in a larger repository (`app/` beside `other/`) checks
`src/a.ts` — never `app/src/a.ts`, which no `fileGlobs` selected — and a
change outside the project is not in scope. The same holds from any
subdirectory: `--cwd src` reads the scope the root reads.

`conventions list` / `get` / `explain` show the same judgement (`applies — …`
or `not applicable here — …`; `--json` adds `applicability: { applicable,
reasons }`) and never hide an entry; `get` / `explain` also print `appliesTo`,
each rule's patterns, `references` and `tags`. MCP `list_conventions` /
`get_convention` carry `applicability`; `prepare_agent_task` hands the agent
only conventions that apply to this workspace.

**Profile detection reads marker files (round 15).** `has-turborepo` is a
`turbo` dependency, a root `turbo.json` or a `.turbo` directory — the two
markers were tested against a directory-only, ignore-filtered listing and could
never be seen.

## Shape

```ts
interface IConvention {
  id: string;
  title: string;
  description?: string;
  kind: 'path' | 'naming' | 'barrel' | 'layout' | 'command' |
        'validation' | 'ownership' | 'testing' | 'release' | 'safety';
  appliesTo?: { languages?: ...; frameworks?: ...; fileGlobs?: ...;
                constructKinds?: ...; profileIds?: ... };   // every filter scopes — see "Where a convention applies"
  rules: { id, description, expectMatch?, forbidMatch?, filePattern?,
           severity? }[];   // each pattern is a regex over the project-relative path
  examples?: { description, good?, bad? }[];
  references?: { kind: 'file' | 'doc' | 'command' | 'knowledge' | 'rule'; value }[];
  severity: 'info' | 'warning' | 'error';
  tags?: string[];
}
```

A rule's patterns are regexes over each covered file's project-relative path:
`filePattern` and `expectMatch` must match (a file in scope that does not is a
hit), `forbidMatch` must not (a match is a hit). Round 15: `expectMatch` was
validated and never evaluated, so an `error` rule of only `expectMatch` could
never fail — it is evaluated now, as its JSDoc ("what *should* match") and the
`forbidMatch` symmetry describe.

Every file is read in ONE spelling — project-relative, `/`-separated, no
leading `./` (`conventionFilePath`) — by the scope test and by every rule
pattern alike, and a hit names that path: `--files ./src/a.ts` or an absolute
path is checked exactly as `src/a.ts`.

### Validation (round 11)

`validateConvention` checks the closed unions, not just the presence of fields.
**Errors** — the convention is dropped with an `invalid-convention` issue that
names the allowed values:

- `kind`, `severity` or a rule's `severity` outside its enum (or a missing
  `severity`) — only `error` fails `conventions check`, so any other value was a
  check that could never fail;
- a reference `kind` outside `ConventionReferenceKind`
  (`file | doc | command | knowledge | rule`), or `references` that is not an
  array;
- a rule that is not an object, an `expectMatch` / `forbidMatch` /
  `filePattern` that does not compile, an `appliesTo` list that is not a list;
- (round 15) an `appliesTo` key that is not one of the five filters (with a
  did-you-mean), or a malformed `fileGlobs` list (a bare `!`, `!!x`, negations
  only).

**Warnings** — the convention still loads, reported as `convention-shape`: an
unknown top-level key, a rule without a string `id` / `description`, a
reference without a `value`, a non-array `tags` / `examples`, and (round 15) a
non-empty `appliesTo.constructKinds` (reserved — not evaluated).

**Rejected entries (round 12).** A convention with an error above — a missing
`severity`, say — is REFUSED, and the refusal is never silent: `shrk
conventions list` ends with `⚠ 1 entry rejected from <file>: 'conv.b'
(default[1]) — severity: severity must be one of: info, warning, error (got
undefined) → shrk conventions doctor` (exit unchanged; `--json` writes it to
stderr), `shrk self-config doctor` reports `convention-invalid` (error), and
`shrk packs doctor` / `packs contributions` name the file. The pack build is a
transpile, so annotate the file with `satisfies IConvention[]` to have `shrk
packs test <pack> --typecheck` catch it too (docs/pack-authoring.md).

## MCP

- `list_conventions`, `get_convention`, `get_conventions_doctor` —
  read-only. `list_conventions` / `get_convention` carry each entry's
  `applicability` (round 15).

## Schemas

- Convention shape: described by `IConvention` (no schema marker).
- Registry: `sharkcraft.convention-registry/v1`.
- Check report: `sharkcraft.convention-check/v1`.
