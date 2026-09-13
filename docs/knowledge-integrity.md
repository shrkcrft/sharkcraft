# Knowledge integrity (R29)

R29 makes knowledge entries verifiable: each entry MAY declare
`references[]` and `anchors[]` that the engine checks against the
workspace. `shrk knowledge stale-check` is the standing verifier.

> **Strict by default (round 11).** Every entry in scope lands in exactly ONE
> of three buckets — **verified** (at least one reference / anchor was checked
> and none is broken), **stale** (a checked one is broken), **unverifiable**
> (nothing checkable: no `references[]` / `anchors[]`, or only `url`,
> unpinned, malformed or unresolvable ones). An unverifiable entry was
> **never checked**, so it is a coverage shortfall on the verdict: **any
> unverifiable entry settles the run to exit `2` (not verified) — never `0`** —
> unless you accept it explicitly with `--min-referenced <ratio>` (or
> `knowledgeCheck.minReferenced`), and that acceptance is printed next to the
> green. Before round 11 an unreferenced entry was folded into the healthy
> total: `ok=415 stale=0`, exit 0, over a corpus checked a quarter of the way
> — the less verifiable a corpus, the healthier it looked.

## Three buckets, and what a green means (round 11)

```
$ shrk knowledge stale-check
entries in scope: 45 · verified: 33 · stale: 0 · unverifiable: 12 (26.7%)
…
UNVERIFIABLE (12) — never checked; declare references[] (TypeScript), a references: frontmatter list (Markdown) or anchors[]:
  sharkcraft/rules.ts (7): repo.scope.no-unrelated-changes, …
  sharkcraft/paths.ts (4): engine.packages, …
  sharkcraft/docs/guide.md (1): doc.guide — Markdown: add a references: frontmatter list (e.g. references: [file:src/a.ts])

12 entries of 45 (26.7%) declare no checkable reference, so they were never checked. Declare references[] (TypeScript) or a references: frontmatter list (Markdown) (ids listed above), or accept a floor explicitly with --min-referenced <ratio> …
NOT VERIFIED: examined 33 of 45 knowledge entries under /repo, 12 declare no checkable references[] or anchors[], … (this is not a pass)
```

The unverifiable ids are listed grouped by the file that declares them (the
file to edit); `--json` lists every one (`unverifiableIds`, never truncated).

| Flag / key | Effect |
|---|---|
| (default) | any unverifiable entry → `2`; a stale / missing reference → `1` |
| `--min-referenced <ratio\|NN%>` | a ratchet: below the floor → `1` (`reference coverage 73.3% < 80% (--min-referenced 0.8)`); at or above it the unverifiable remainder is **accepted** → `0`, printed `accepted by --min-referenced 0.8: …` |
| `--require-references` (= `--fail-on unverifiable`) | every unverifiable entry is a finding (`UNVERIFIABLE <id>`, with its file) → `1` |
| `--allow-empty` | accepts a legitimately EMPTY scope — a configured repo with no entries, or a changeset no entry references → `0`. It never clears a missing `sharkcraft/` folder or a config that failed to load. |
| `knowledgeCheck.minReferenced` / `.requireReferences` | the same, from `sharkcraft.config.ts` (the flag wins); printed as `accepted by knowledgeCheck.minReferenced: 0.8` |
| `knowledgeCheck.failOn` / `.strict` | the verb reads them too: `failOn` applies when no `--fail-on` flag is given (a flag replaces it wholesale); `strict: true` ("promote any stale to a failure") adds `all` to it. The verb's `--ci` / `--strict` (the R30 required-only modes) take precedence over any `failOn`. |

**One input, three readers.** `shrk knowledge stale-check`, the `shrk quality`
item and `shrk release readiness` all build their input with ONE builder
(`knowledgeStaleGateInput`) and settle it the same way, so for a config-only
request the verb's exit, the quality item's status and
`knowledgeCheck.ready` (`= exit 0`) are one answer. Before, the verb ignored
`failOn` / `strict`, quality read `failOn` only and readiness re-derived its own
verdict — `quality` could pass while its own repro command failed, and
readiness reported `ready: true` over a 100%-unverifiable corpus.

Exit precedence: `3` (malformed request — an unknown `--fail-on` category, a
bad `--min-referenced` / `--stale-after` / `--as-of`, or a category that can
never fire: `aged` — from `--fail-on` or `knowledgeCheck.failOn` — or `--as-of`
without a `--stale-after` window) › `1` (violations) › `2` (not verified) › `0`.
The global `--strict` promotes `2` → `1`. `knowledge verify` is the same verb
(same flags, same verdict).

### A partial corpus is never a pass

A knowledge-bearing file (`knowledgeFiles` / `ruleFiles` / `pathFiles` /
`docsFiles`, local or pack-contributed) that fails to import, times out, or is
declared by the config and does not exist is recorded in
`inspection.loaderDiagnostics` (a missing one as status `missing`) and named by
`discovery.knowledgeLoadFailures`. The run carries a `knowledge-files` rule
(status `error`, coverage `examined L of N knowledge files`), so it settles to
`2` even when every loaded entry verified — and `--allow-empty` never clears a
load failure, at any corpus size. The text lists each file under `LOAD FAILED`.

### A refused entry is never a pass (round 15 follow-up)

An ENTRY its loader refused — a TypeScript entry missing its `content`, a
Markdown file whose frontmatter cannot be read as declared (`title:` holding a
list) — never reaches the corpus, so nothing it claims is checked. It used to
vanish from the verdict: the stale-check printed `N of N knowledge entries
verified ✓` at exit `0`, `shrk quality` passed and `shrk doctor` said "Ready ✓"
over it, while only `self-config doctor` and `knowledge list` named it. Every
verdict surface now reads THE rejection channel's knowledge-family list
(`knowledgeRejectedEntries`, @shrkcrft/inspector — knowledge, rules, paths, path
conventions, docs):

- `knowledge stale-check` prints one INVALID-class row per refused entry —
  `INVALID       k.bad — rejected at load — not checked: content: must be a
  string  (sharkcraft/knowledge.ts)`, the pack named for a pack's — and the
  summary line counts them (`· rejected at load: 2`). The run carries a
  `knowledge-rejected-entries` rule (coverage `examined 0 of N knowledge
  entries`): `2` NOT VERIFIED by default, `1` under `--fail-on invalid`. No
  valve accepts it — `--min-referenced` accepts the unverifiable remainder and
  `--allow-empty` an empty scope, never a refused entry — and a changeset never
  narrows it (its references were never read, so no scope can prove it
  untouched). `--json` carries `rejectedEntries[]` (`{ entryId?, label, source,
  at?, kind, pack?, reasons[], message }`). A `label` names ONE declaration:
  the id, qualified by its declaration site (`k.bad (sharkcraft/more.ts
  default[0])`) when a loaded entry or an earlier refused declaration holds the
  same id — so two refused `k.bad`s never read `k.bad, k.bad`, and `shrk
  doctor`'s check ids stay unique.
- `shrk quality`'s `knowledge-stale` item settles through the same gate (never
  `passed` over one), names each in its notes and carries
  `data.rejectedEntries`.
- `shrk doctor` lists each (`knowledge-entry-rejected`, a warning in the
  `asset-load-failed` category, so `--blockers` keeps it) and settles NOT
  VERIFIED (`2`) — `examined N of M knowledge entries, K rejected at load`.

A `duplicate-id` rejection is not such a row: the entry it collided with IS
checked (the first one wins), and the validator reports the duplicate — the
precedent refused gate-plane rules set.

### `--changed-only` scope

An entry (or boundary rule / policy check) is in a changeset's scope when the
file that DECLARES it changed (a new or edited reference is checked by the run
that introduced it), when a changed path equals a reference / anchor path or
lies UNDER one (a `directory` reference whose files changed, or a directory
deleted wholesale), or when a changed path matches a `count` source glob.

`count` sources never walk the `sharkcraft/` dir by default — the claims live
there and would count themselves (prose saying `registerService("<name>")`
inside a `**/*.ts` glob). A count whose own globs target inside that dir keeps
walking it.

`--json` carries `coverage` (`entriesInScope`, `verified`, `stale`,
`unverifiable`, `unverifiablePct`, `referencedRatio`), `entryVerdicts[]`
(verdict, reason, source, `sourceFormat` — `typescript` / `markdown` /
`other` — `pack` for a pack's entry, checkable, failing), `unverifiableIds[]`,
`rejectedEntries[]` (entries the loader refused — above), `failureCounts`,
`byAssetKind` / `byEntryType` / `byReferenceKind`,
`discovery`, `exitCode`, and the shared `gate` envelope (`sharkcraft.gate/v1`):
one rule `knowledge-references` of type `knowledge`, `skipped` with a
`skipReason` when nothing in scope was checkable (plus `knowledge-files` and
`knowledge-rejected-entries` when a file never loaded or an entry was refused —
above). `entries` stays the corpus
total; a scoped run (`--changed-only` / `--since` / `--staged` / `--files`)
examines `entriesInScope`. `shrk quality` runs the SAME gate as its
`knowledge-stale` item, with `knowledgeCheck` standing in for the flags.

### Per-kind table — which kinds were even looked at

The text output breaks the sweep down by asset kind (knowledge / boundary rule
/ policy) and by knowledge `type`: scanned · zero-refs · refs · verified ·
stale · unverifiable. A kind with nothing in the sweep says so in words (`none
declared`, `not in sweep`) — a row of zeros cannot tell "clean" from "never
looked".

### Loading nothing is a configuration failure

Run from a nested workspace member (its own `package.json`, no `sharkcraft/`),
discovery binds to that member and loads 0 entries. That is never a pass:
exit `2`, naming the resolved root, whether `sharkcraft/` exists, the config
(or its load error), and the configured ancestor to rerun from (`--cwd
<ancestor>`). Discovery is deliberately NOT widened to walk up: that would
silently rebind every nested workspace package to the parent's config.

### Registries are warmed before anything resolves

`playbook` / `policy` / `construct` / `helper` ids come from async-filled
registries. Every consumer awaits `warmReferenceRegistries` (CLI:
`warmCliReferenceRegistries`, which also injects the command index) before
building the report. A registry that was never loaded — or is empty — makes
an id `unknown` (`NOT VERIFIED`), never `stale`: a gate that flags correct ids
is the fastest way to get it switched off.

## Reference kinds

| kind | required fields | meaning |
|---|---|---|
| `file` | `path` | Project-relative file path. |
| `directory` | `path` | Project-relative directory. |
| `symbol` | `symbol`, optionally `path` | Exported function / class / type / enum. |
| `command` | `id` or `command` | A command string that resolves against the live command index (see below). |
| `template` | `id` | A registered template. |
| `playbook` | `id` | A pack-contributed playbook. |
| `construct` | `id` | A registered construct. |
| `helper` | `id` | A helper id from the R28 helper registry. |
| `policy` | `id` | A policy check id. |
| `boundary-rule` | `id` | A boundary rule id. |
| `path-convention` | `id` | A path-convention id. |
| `package` | `id` | A package the project root's `package.json` names (its `name` or a workspace). For a pack's reference, the CONSUMER's root — plus the contributing pack's OWN name, which is installed by definition (round 15 follow-up). |
| `url` | n/a | Not verified — no network. |

### Markdown knowledge declares references too (round 15)

A Markdown knowledge file (`knowledgeFiles` / `ruleFiles` / `pathFiles` /
`docsFiles`, local or from a pack) declares its references in a
`references:` frontmatter list. Each item becomes the SAME reference a
TypeScript entry declares — validated by the one validator, checked by the one
stale engine. Three item shapes, each equal to the TypeScript literal:

```md
---
id: doc.guide
references:
  - kind: symbol                 # 1. a map of reference fields (any references[] field)
    symbol: Foo
    path: src/foo.ts
    contains: "export class Foo"
    required: true
  - kind: file
    path: src/a.ts
---
```

```md
---
references: [file:src/a.ts, "symbol:Foo@src/foo.ts", template:app.service:required]
---
```

```md
---
references:
  - file:src/a.ts                # 3. block items in the --reference grammar
  - symbol:Foo@src/foo.ts
---
```

Shape 2 and 3 use the `--reference` grammar (`kind:value[:required]`,
`symbol:Name@path`) — `parseReferenceSpec`, the inverse of the renderer the
stale-check prints with, so a printed row pastes back as an item.

Refused loudly — the entry is rejected, and `self-config doctor`,
`packs contributions` and `packs test --load` name the reason:

- a list mixing strings and maps — write every item one way; quote all compact
  strings or none (an unquoted `:` makes a block item a map);
- a `count` — its `source` selector nests deeper than frontmatter maps go:
  declare that entry in TypeScript;
- a flow map (`[{ kind: file, path: src/a.ts }]`);
- frontmatter the parser cannot read in a key the loader reads (a stray line,
  a bad indent), or a field of the wrong shape (`title:` holding a list).

A malformed ITEM — an unknown kind, a missing field, a string the grammar
refuses (`bogus:x`) — loads AS DECLARED and fails exactly like the same item in
TypeScript: `invalid-reference` in `shrk doctor`, an INVALID row here. A
non-list `references` value (`references: src/a.ts`, TypeScript or Markdown)
is an `invalid-reference` error that keeps the entry, and one INVALID row — it
used to crash every inspection-backed verb. `anchors` take the same path: a
non-list value, a `null` item or a non-string `path` / `symbol` / `targetId` is
an `invalid-anchor` error that keeps the entry, and one INVALID row naming the
anchor (`k → anchor #1 — malformed anchor: is not an object (got null).`).
`defineKnowledgeEntry` carries a non-list value as declared, so it is reported
the same way (it used to throw at import and take the whole file down).
`required` is a boolean (round 15 follow-up): `required: yes` in a Markdown map
item (the parser reads the string `"yes"`) or `required: 'yes'` in TypeScript
read as NOT required, so `--ci` / `--strict` waived the reference its author
meant to block on. Either is malformed through the same item-shape predicate —
`invalid-reference` (`has a non-boolean \`required\` (got "yes") — write
required: true or required: false`) and an INVALID row; `required: true` /
`false` (and the compact `file:src/a.ts:required`) are unchanged.
`shrk knowledge references <id>` and MCP `get_knowledge_references` print one
listing — the usable references and anchors, plus `malformed[]`
(`{ field, position?, value, problem }`, the doctor's words at the doctor's
`reference #N` / `anchor #N`) — so a malformed item is never missing from it.

Frontmatter is read by THE frontmatter parser (`parseFrontmatter`,
@shrkcrft/core — the one `spec.md` uses): an indented line belongs to the key
above it, so a nested `id:` / `title:` / `type:` / `priority:` (under
`metadata:`, inside a `references:` item) never overwrites the entry's own. A
key the loader does not read is dropped with a warning, whatever YAML it holds.

A Markdown entry with no references is still unverifiable — exit `2`, never an
implicit pass. The per-file line names the fix (`sharkcraft/docs/guide.md (1):
doc.guide — Markdown: add a references: frontmatter list …`), and each surface
names the valve it has: `--min-referenced` on this verb,
`knowledgeCheck.minReferenced` in `shrk quality` (which refuses the flag, exit
`3`). `shrk quality --json` carries an accepted remainder in its top-level
`accepted` (`knowledge-stale: accepted by knowledgeCheck.minReferenced: 0.5: …`).

An entry whose references EXIST but none is checkable — a malformed item (a
non-boolean `required`, an unknown kind or `root`), or only `url:`s — is told
to fix what it declared, never to declare a list it already has (round 15
closing): its file line reads `sharkcraft/knowledge.ts (1): k.bad — its
references[] / anchors[] declare nothing checkable — fix the item its INVALID /
UNKNOWN row names, …` (`Markdown: its references: frontmatter list declares
nothing checkable — …` for a `.md`), the heading reads `each declares
references, none checkable — fix the item each INVALID / UNKNOWN row names`
(both clauses for a run mixing the two reasons; ONE heading,
`unverifiableListHeading`, in the text and the `--format markdown` report
alike), the lead says `Make a declared reference checkable`, and
`--require-references` names the same fix. A file whose entries need different
fixes gets one line per fix.

A missing path's hint names who fixes it (round 15 closing): a Markdown
entry's row reads `Restore the file, or edit this reference's path in the
references: frontmatter of <file>` (`shrk fix --knowledge-stale --apply` lands
rename plans on TypeScript entries only), a pack's names the pack — and `root:
pack` when the pack ships the path — and a TypeScript entry's suggests `shrk
knowledge rename-file`. One authority builds it, so the stale-check row, the
gate violation, `fix preview`'s draft and MCP agree.

`shrk fix --knowledge-stale --apply` edits TypeScript literals only: a Markdown
entry's stale reference is refused (exit `1`), naming the `.md` file to edit.
The preview (`shrk fix preview --knowledge-stale`, round 15 follow-up) says so
up front — a Markdown entry's suggestion reads `not auto-fixable: <id> is
declared in Markdown (<file>) …`, a pack's names the pack, and neither gets an
`--apply` command — and suggests only commands the dispatcher runs: `shrk
knowledge rename-file <old> <new>` / `rename-symbol <old> <new>` (read-only
previews already; they take no `--dry-run`), `shrk fix preview --knowledge-stale
--target <id>` (`fix` takes no positional), and for a local TypeScript entry
`shrk fix --knowledge-stale --apply [--drop-stale | --drop-missing]`. A rename
is suggested only for a MOVED target — a missing path (`rename-file`) or a
symbol no longer declared in its file (`rename-symbol`), never a `contains` /
`count` mismatch on a file that is still there — and only for an entry
`--apply` can land it on (never a Markdown or a pack entry). The preview warms
every reference registry before it folds in the stale report, so its rows
agree with `knowledge stale-check` (a `command:` reference is checked against
the live command index, not reported "not injected").

### Pack references and `root: pack` (round 15 follow-up)

A reference a pack contributes resolves against the CONSUMER's tree by
default: a `file:` / `directory:` path joins the consuming project's root, and
`package:` reads the consumer's root `package.json` (its `name` and
workspaces) — plus, for the pack's own entries, the contributing pack's OWN
name (`package:@x/y` on an entry `@x/y` ships is `ok`: the pack is installed by
definition).

To verify a pack's entry against a file the PACK ships, declare `root: pack`
on the reference (`KnowledgeReferenceRoot.Pack`, @shrkcrft/core; the default,
and what an absent `root` means, is `project`):

```md
---
references:
  - kind: file
    path: docs/guide.md
    root: pack
---
```

```ts
references: [{ kind: 'symbol', symbol: 'PackThing', path: 'src/thing.ts', root: KnowledgeReferenceRoot.Pack }],
```

- Every path-based read resolves against the contributing pack's package
  directory, as pack discovery found it (`node_modules/@x/y`): a `file` /
  `directory` / pinned `symbol` path, `contains` / `matches`, and a `count`
  source. The consumer's code graph never indexes a pack, so a pack-rooted
  symbol is read from its pinned file.
- Every row names the root it resolved against: `File exists: docs/guide.md
  (root: pack — @x/y at node_modules/@x/y)`.
- A Markdown map item takes `root: pack`; the compact string grammar
  (`file:docs/guide.md`) carries no root and is unchanged.
- `root: pack` is valid only on a pack-contributed asset (a knowledge entry, a
  boundary rule or a policy check a pack ships). On a local asset it is an
  INVALID row here — never a silent fallback to the project root, which would
  read a different file — and, on a local knowledge entry, an
  `invalid-reference` error in `shrk doctor` (the boundary-rule and policy
  loaders validate a reference's `kind` only, so for those the INVALID row is
  the signal). An unknown `root` value is the same error; `root: pack` on a
  reference with nothing path-based (a `template:` id) is a warning: it has no
  effect. `packs test --load` judges a pack's knowledge entries with the same
  predicate (an unknown root fails it, exit `1`).
- `shrk knowledge references <id>` prints a non-default root next to the
  reference (`• file: docs/guide.md [root: pack]`); `--json` and MCP
  `get_knowledge_references` carry the `root` field.
- A pack's project-rooted path that is missing from the consumer's tree is
  STALE, and the hint names the fix — `docs/guide.md is shipped inside pack
  @x/y (node_modules/@x/y/docs/guide.md), but a pack's path resolves against
  the consuming project's root — declare root: pack on this reference, in the
  pack, …`. A pack's reference never gets a rename candidate from the
  consumer's tree: it is fixed in the pack.
- `--changed-only` sees a pack-rooted path where it lives
  (`node_modules/@x/y/docs/guide.md`) — and a pack-rooted `count` source's
  globs too (`node_modules/@x/y/src/*.ts`), so a change to the consumer's
  `src/` never scopes in a count measured over the pack's.

Id kinds — `template:`, `playbook:`, `construct:`, `helper:`, `policy:`,
`command:`, `boundary-rule:`, `path-convention:` — resolve wherever the pack
is installed, with or without a root. The stale-check names the pack for its
unverifiable entries (`pack @x/y (Markdown): add a references: frontmatter
list upstream …`); a consumer accepts the remainder explicitly with
`knowledgeCheck.minReferenced`.

### `command` references resolve against the command index (round 11)

A `command` reference (and a `command` anchor) is checked by THE
command-string resolver — the same one the self-config doctor and agent tests
use — against the live command index (every dispatchable verb, subverb and
meta flag; `shrk surface list` prints it). Before round 11 any string starting
with `shrk ` passed, so three dead commands in shrk's own knowledge were
reported "Command available".

| resolver status | outcome |
|---|---|
| `ok`, `prefix-only` (verb proven, internal tail unprovable), `not-shrk` (git, tsc, …) | `ok` |
| `unknown-verb` / `unknown-subverb` / `unknown-script` / `unknown-tool` | `stale`, with the closest real command as the suggestion |
| no resolver injected (a direct engine call, MCP) | `unknown` — `command index not injected — NOT VERIFIED`, never `ok` |

A `command` reference names a shrk command, so a BARE form is read as one:
`{ kind: 'command', command: 'doctor' }` resolves as `shrk doctor` (`ok`) and
`'frobnicate'` as an unknown shrk verb (`stale`). A head that is
not a shrk verb but a package manager or a known executable (`bun test`,
`git status`) stays `not-shrk`. The self-config doctor and an agent test's
`expectedCommands` read the same string the same way — the reading is decided
once, in the CLI resolver, and asked for through `resolveShrkCommandReference`.

The command index lives in the CLI, above the inspector, so the CLI injects the
resolver: `warmReferenceRegistries(inspection, { commandResolver })` (CLI code
calls `warmCliReferenceRegistries(inspection)`). The inspector reads it through
`resolveShrkCommandReference` (a command reference) /
`resolveCommandReference` (free shell text) / `referenceIdStatus` (tri-state
`Exists` / `Missing` / `Unverifiable`).

## Anchor kinds

Anchors are named points that rename tools can update:
`file | symbol | command | construct | template | helper | playbook | policy`.

## Content assertions (round 11)

A reference used to assert only that a path exists — the weakest proxy for
what an entry claims. A file survives a rename-inside refactor untouched while
every statement about its contents goes false. Every field below is optional:

| field | applies to | asserts |
|---|---|---|
| `contains: "<literal>"` | `file`, `symbol` | the file — or the pinned symbol's DECLARATION span — still contains it |
| `matches: "<regex>"` | `file`, `symbol` | it still matches (compiled with the `m` flag; separate from `contains`, so a literal is never read as a regex) |
| `scan` | with `contains` / `matches` | which lexical zone is read: `all` (default) · `code` · `strings` · `comments` · `code-and-templates` — the policy plane's and the extraction DSL's vocabulary; `code` stops a comment that merely mentions it from satisfying the claim |
| `count: { source, expected, measure? }` | any kind | re-derives a number with an [extraction-DSL](extraction-dsl.md) `source`, measured by `inspectSource` (the one extraction authority); `measure: 'ids'` (default) or `'sites'`. A source that matched 0 files measured nothing: `unknown`, never a pass. `$use` is not resolved here — inline the selector. |

```ts
references: [
  { kind: 'symbol', symbol: 'signPlan', path: 'packages/generator/src/plan-signing.ts' },
  { kind: 'symbol', symbol: 'Foo.bar', path: 'src/foo.ts', contains: 'return' },
  { kind: 'file', path: 'CLAUDE.md', contains: 'core → workspace → config → knowledge' },
  { kind: 'directory', path: 'src/handlers',
    count: { source: { files: ['src/handlers/*.ts'], pattern: 'export const (HANDLER_\\w+)' }, expected: 12 } },
],
```

A failed assertion reports what it found beside what was claimed (`count 13 ≠
expected 12 — set expected: 13`), so the fix is a one-token edit.

### `Owner.member` symbols

The symbol index also indexes ONE level of members: class methods /
properties / accessors, interface members, enum members, namespace
declarations, and the keys of a `const x = { … }` object literal.
`symbol: 'Foo.bar'` (or `Foo.prototype.bar`) resolves against the owner's
declaring file; with a code graph, the graph answers for the OWNER (moved
detection) and the AST verifies the member. A BARE member name stays `stale` —
a name never silently widens to members — but the message names the qualified
spelling and `replaceWith.symbol` carries it, so `shrk fix --knowledge-stale
--apply` can rewrite it. An owner that is only re-exported in the pinned file
is `unknown` (pin the declaring file), never a false `ok`.

### Failure modes

`outcome` (`ok | stale | missing | unknown`) keeps its historical values; every
non-ok check also carries a `failure`:

| `failure` | meaning | gate with |
|---|---|---|
| `path-missing` | the file / directory — or a symbol's pinned file — does not exist | `--fail-on path-missing` |
| `anchor-missing` | the path exists; the symbol / member it pins does not | `--fail-on anchor-missing` |
| `content-mismatch` | `contains` / `matches` no longer holds | `--fail-on content` |
| `count-mismatch` | a `count` re-derived to a different number | `--fail-on count` |
| `id-unregistered` | an id-keyed reference is not registered | the legacy default (`stale`) |
| `unverifiable` | the check could not run — nothing was proved | the entry may be UNVERIFIABLE (coverage) |

`--json` carries `failureCounts`; the text summary prints the non-zero ones.

The **path-only advisory** (`path-only-reference`, never gating) flags an
entry whose references are all paths while its prose names, in backticks, a
symbol one of those files declares — with the `symbol` reference to paste.

### `verifiedOn` and `--stale-after`

`verifiedOn: 'YYYY-MM-DD'` records the day an author last checked the entry
against the code (Markdown knowledge: a `verifiedOn:` frontmatter line);
`shrk knowledge get` prints it with its age. It is author attestation, not
index freshness — it never changes a reference outcome or a bucket.
`--stale-after 6m [--as-of 2026-09-11]` lists the entries not verified within
the window (oldest first) and those never verified; `--fail-on aged` gates on
it. `--as-of` defaults to today (UTC) and is echoed in `age.asOf`. A date that
is not a real `YYYY-MM-DD` is an `invalid-verified-on` validation error.

### Boundary rules and policy checks declare references too

`IBoundaryRule.references` and `IPackPolicyCheck.references` take the same
shape — core's `IAssetReference`, which `IKnowledgeReference` aliases. The same
sweep checks them and reports them per asset kind (the table, and
`assetReferenceChecks`), NOT folded into the knowledge buckets. A stale
declared reference counts like a knowledge one (the legacy default fails on
it). A boundary rule's `from` glob whose static prefix does not exist is an
IMPLICIT `path-missing` reference (`implicit: true`, advisory; `--fail-on
implicit` gates). Policy checks keep their real scope inside `evaluate()`,
which cannot be read without running it — the sweep says so
(`policy-scope-unverifiable`) instead of guessing.

## Commands

```
shrk knowledge stale-check [--changed-only|--since <ref>|--staged|--files a,b]
                           [--min-referenced <ratio|NN%>] [--require-references] [--allow-empty]
                           [--fail-on <category,...>] [--stale-after <Nd|Nw|Nm|Ny> [--as-of YYYY-MM-DD]]
                           [--ci] [--strict] [--baseline <file>] [--report] [--format text|markdown|html|json] [--json]
shrk knowledge verify                                       # alias — the same verdict
shrk knowledge references <id> [--json]
shrk knowledge anchors [--json]

shrk knowledge rename-symbol <old> <new> [--write] [--json]
shrk knowledge rename-file <old-path> <new-path> [--write] [--json]
shrk knowledge update-anchor <anchorId> [--to-symbol|--to-path|--to-target-id <value>] [--write]
```

## Schema

Stale-check report: `sharkcraft.knowledge-stale/v1`. Includes
per-finding `outcome: ok|stale|missing|unknown` plus a
`symbolConfidence: exact|probable|missing|unknown` for symbol
references.

Rename plan: `sharkcraft.knowledge-rename/v1`. Lists every entry that
matches the rename plus the before/after value.

## Backwards compatibility

Pre-R29 entries omit `references` and `anchors` and still load. The
stale-check simply reports `0 references checked` for them.

## MCP

- `get_knowledge_stale_report({ changedFiles? })`
- `get_knowledge_references({ id })`
- `preview_knowledge_rename({ kind, from, to, anchorId?, toSymbol?, toPath?, toTargetId? })`

All read-only.

## Decision

`sharkcraft/decisions/knowledge-is-verifiable-not-tribal.md` documents
the policy intent.

## R30 — CI / preflight gate

Stale-check learns CI controls. Local mode stays non-blocking.

```
shrk knowledge stale-check --ci
shrk knowledge stale-check --strict
shrk knowledge stale-check --fail-on required,stale
shrk knowledge stale-check --baseline <prior.json>
shrk knowledge stale-check --report --format json --output .sharkcraft/reports/knowledge-stale.json
```

| Flag | Effect |
|---|---|
| `--ci` | exit non-zero if any reference with `required: true` is `stale` or `missing` |
| `--strict` | exit non-zero on any stale or missing required reference (alias of `--ci` today; reserved for stricter rules) |
| `--fail-on required` | exit non-zero only on `required: true` failures |
| `--fail-on stale` | exit non-zero on any stale outcome |
| `--fail-on missing` | exit non-zero on any missing outcome |
| `--fail-on all` | exit non-zero on any stale or missing reference |
| `--baseline <file>` | compare against a prior `--report` JSON; report `newStale` / `newMissing` / `resolved` |
| `--report` | write `.sharkcraft/reports/knowledge-stale-<timestamp>.json` |
| `--format text|markdown|html|json` | choose output format |
| `--output <path>` | explicit report path |

### Release readiness integration

```
shrk release readiness --strict --with-knowledge-check
```

Or set `knowledgeCheck.enabled: true` in `sharkcraft.config.ts`. Readiness
runs THE stale-check verdict — the verb's input builder, gate and settle — and
surfaces `knowledgeCheck: { ready, exit, verdict, reasons, shortfalls,
accepted, requiredFailing, counts, coverage, unverifiableIds, failOn, repro }`.
`ready` is exactly `shrk knowledge stale-check` exiting `0` on the same config:
a stale reference, an unverifiable remainder no `minReferenced` floor accepts,
or a knowledge file that never loaded makes it `false`, forces the report's
`ready: false`, and adds a `knowledge-check` blocker naming the cause.

```ts
// sharkcraft.config.ts
const config = {
  // ...
  knowledgeCheck: {
    enabled: true,        // include in release readiness
    strict: false,        // true: promote any stale to a failure (adds `all` to failOn)
    failOn: ['required'], // replaces the default (any stale / missing fails); a --fail-on flag replaces this
  },
};
```

## R30 — AST-backed symbol verification

`packages/inspector/src/symbol-index.ts` parses single files via the
TypeScript compiler API (no whole-program type-checking, no extra
dependencies). Symbol references now report richer confidence:

- `exact-export` — declared with the `export` keyword.
- `exact-local` — declared in the file but not exported.
- `exact-reexport` — surfaced via `export { foo } from "..."`.
- `probable-text` — file could not be parsed; symbol appears as text.
- `missing` — symbol not declared or re-exported.
- `unknown` — file unreadable, etc.

The R29 text-scan path remains the fallback so a parse failure never
crashes the engine.
