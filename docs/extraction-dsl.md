# The extraction DSL (`IWiringSource`)

Every data-defined plane in shrk — [wiring](wiring.md), [registry
inventories](registry-inventory.md), the registration graph, and
extractor-backed [baselines](baseline-drift.md) — ultimately does one thing:
**pull ids out of source files without a compiler**. That extraction is a single
shared primitive, so a new extractor kind lands in every plane at once and all
of them behave identically.

A source is a set of globs plus a way to read them:

```ts
{
  files: ['src/plugins/**/*.ts'],   // what to scan
  extract: 'export-names',          // how to read it
  match: '.*Plugin$',               // keep only these ids  (optional)
  exclude: '^legacyPlugin$',        // then drop these      (optional)
}
```

There is no AI and no per-language toolchain: the extractors are a **lexer**,
which is the largest thing that stays honest across `.ts`, `.kt`, `.swift`,
`.scss`, `.json` and inline template strings with one code path.

## Extractor kinds

| `extract` | Reads | Needs |
|---|---|---|
| `regex-capture` | capture group 1 of `pattern` — the escape hatch | `pattern` |
| `array-members` | elements of the `anchor` array literal | `anchor` |
| `object-keys` | top-level keys (or values, see `capture`) of the `anchor` object | `anchor` |
| `enum-members` | members of `enum <anchor> { … }` (name or value) | `anchor` |
| `export-names` | every exported binding name in the file | — |
| `call-args` | argument `argIndex` of every call to `anchor` | `anchor` |
| `decorator-args` | argument `argIndex` of every `@anchor(…)` | `anchor` |
| `string-union-members` | the string literals of `type <anchor> = 'a' \| 'b'` | `anchor` |
| `json-path` | leaves selected by `jsonPath` in a JSON document | `jsonPath` |
| `filenames` | one id per FILE matching the globs, captured from the path | — |
| `import-edges` | resolved dependency edges from the scanned files to `to` | `to` |

### Shared fields

| Field | Meaning |
|---|---|
| `$use` | Reference a named [shared extractor](#shared-extractors-use) instead of re-typing its selector. |
| `files` | Project-relative globs (`**`, `*`, `?`). Required unless `$use` supplies them. |
| `anchor` | The construct to locate. A **dotted** anchor addresses a method call: `anchor: 'registry.register'` matches `registry.register(x)` and nothing else. |
| `argIndex` | Which argument carries the id for `call-args` / `decorator-args` (default `0`). |
| `capture` | `name` (default) or `value` — which half of a `key: value` / `Member = 'v'` pair becomes the id. Applies to `object-keys` and `enum-members`. |
| `jsonPath` | `.key`, `[n]`, `[*]`; a leading `$.` is accepted. A selected object contributes its **keys**; a selected array, its scalar elements. |
| `match` | Allow-filter: keep only ids this regex matches. |
| `exclude` | Deny-filter, applied after `match`: drop ids this regex matches. |

### `match` + `exclude`: declaring an exception as data

The pair is how a **known, deliberate** exception is written down without
weakening the rule. This repo's own MCP-tool wiring rule keeps six
intentionally-retired exports out of the declared set — and a **new** omission
still turns the rule red:

```ts
declared: {
  files: ['packages/mcp-server/src/tools/*.tool.ts'],
  extract: 'export-names',
  match: 'Tool$',
  exclude: '^(simulateWorkflowTool|listReleaseTrainsTool|…)$',
}
```

Anchor an `exclude` (`^(a|b)$`) unless a prefix match is really what you mean.

## Shared extractors (`$use`)

Three planes routinely describe the **same id set**: a wiring rule's `declared`,
a registry's `source`, and a baseline's `compute.source` all pointing at
`src/handlers/*.ts` extracting `*_HANDLER`. Written out three times they drift —
a directory move updated in two of the three leaves the planes silently checking
*different sets*, and all three still report a confident pass. That is precisely
the bug class this engine exists to kill, so it must not be reintroduced by
copy-paste in the config itself.

Define the selector **once** under the top-level `extractors` map and reference
it by id:

```ts
export default {
  extractors: {
    handlers: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_HANDLER$' },
  },
  wiringRules: [{
    id: 'handlers-registered',
    declared: { $use: 'handlers' },
    registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
  }],
  registries: [{ name: 'handlers', source: { $use: 'handlers' } }],
  baselines: [{
    id: 'handler-roster',
    baseline: 'sharkcraft/handler-roster.txt',
    compute: { kind: 'extractor', source: { $use: 'handlers' } },
  }],
};
```

One definition, three consumers, **no copy that can fall out of date**.

### Overriding

Any field spelled alongside `$use` overrides the shared one for that consumer
only, so sharing is never all-or-nothing:

```ts
declared: { $use: 'handlers', match: '^ALPHA' }   // same files, narrower subset
```

### Guarantees

- **Opt-in.** Inline selectors keep working exactly as before.
- **Resolved at load.** Every engine downstream sees a fully-resolved source;
  `$use` survives only as provenance for the explain views.
- **A typo fails the load**, with the dotted path to the offending source and the
  list of declared ids. An unresolvable reference is never degraded into "a
  source with no files", which would match nothing and read as a pass.
- **One hop only.** A named extractor may not `$use` another — "which files does
  this rule scan?" stays a lookup rather than a graph traversal.
- **Pack rules resolve against the LOCAL map.** A pack may ship a rule shape that
  `$use`s a selector the adopting repo supplies. If the repo does not declare
  that id the pack element is dropped with a diagnostic, never kept half-resolved.

### Seeing the shared set

`shrk gates coverage` reports each shared extractor **once**, with its live match
count and the rules that consume it — one line proving N rules point at the same
non-empty set:

```
  shared extractors
  ✓ $use:handlers  —  2 ids across 1 file(s), shared by 3 rule(s): wiring:handlers-registered, registry:handlers, baseline:handler-roster

  ✓ [wiring] handlers-registered (via $use:handlers)  —  2 ids across 1 file(s)
```

## `filenames` — the companion-file invariant

Every other extractor reads a file's CONTENTS, so "a declared thing must have
its sibling **file**" had no expression at all. `filenames` yields one id per
matched file, derived from its path:

```ts
registered: { files: ['src/**/*_DESCRIPTOR.ts'], extract: 'filenames' }
// → ALPHA_DESCRIPTOR, BETA_DESCRIPTOR, …
```

| `capturePath` | id for `src/nested/BETA_DESCRIPTOR.tsx` |
|---|---|
| `stem` (default) | `BETA_DESCRIPTOR` — basename up to the first dot |
| `basename` | `BETA_DESCRIPTOR.tsx` |
| `regex` | group 1 of `pathPattern`, applied to the whole project-relative path |

Pair it with a [`parity`](wiring.md#parity-mode-mode-parity) wiring rule to
assert the correspondence in **both** directions — a const with no file *and* a
file with no const:

```ts
{
  id: 'descriptor-has-file',
  declared:   { files: ['src/registry.ts'], extract: 'array-members', anchor: 'DESCRIPTORS' },
  registered: { files: ['src/*_DESCRIPTOR.ts'], extract: 'filenames' },
  mode: 'parity',
}
```

`pathPattern` is deliberately not `pattern`: that field is sugar meaning
`extract: 'regex-capture'`, and letting it mean two things would make "which
extractor is this?" ambiguous at a glance.

## `import-edges` — the dependency graph as a rule input

Every other extractor reads file contents, so an entire class of invariant —
**alias-resolved dependency direction** — was inexpressible, and repos
hand-rolled scripts for it (adoption ledgers, orphan scans). This emits the
dependency edges as an id set, so every existing plane gets them for free.

```ts
{
  files: ['apps/**/*.ts'],                                   // the CONSUMER glob
  extract: 'import-edges',
  to: { module: '@x/generated', match: '^Nge.*View$' },       // the target
  emit: 'edge',                                              // what each id is
}
```

`files` is the `from` side — the same field every extractor uses, so
`--changed-only` footprinting, the shared walk and `$use` all work on it
unchanged.

### Targeting (`to`)

| Field | Selects | Matches by |
|---|---|---|
| `module` | the specifier exactly, or a subpath of it: `@x/generated` matches `@x/generated` and `@x/generated/views`, never `@x/generated-legacy` | the **specifier as written** |
| `modulePattern` | a regex over the literal specifier | the **specifier as written** |
| `files` | globs over the **directly-resolved** target path; common extensions and `/index.*` are probed | the **resolved path** |
| `match` | a regex over the imported **symbol** name | the symbol |

At least one is required. A rule with no `to` would pin every import in the
tree, which is never what an author means — so it is refused at config load.

#### `to.files` vs `to.module` — the barrel case

This is the one place intuition reliably trips. **`to.files` matches an import's
DIRECTLY-resolved path.** A symbol re-exported through a barrel resolves to the
package entry, not to the deep file it originally came from:

```ts
// libs/ui/index.ts  (the barrel)
export { NgeCardView } from './generated/NgeCardView';

// apps/consumer.ts
import { NgeCardView } from '@x/ui';        // resolves to libs/ui/index.ts
```

```jsonc
to: { files: ['**/generated/**'] }          // ← 0 edges. Correct, but not what you meant.
to: { module: '@x/ui', match: 'View$' }     // ← the real adoption edges.
```

The zero-match is *technically right* — the import literally resolves to the
barrel index — which is exactly why it is confusing. So the engine says so:
when an `import-edges` rule targets `to.files`, scans a non-empty `from` set and
yields **0 edges**, the loud-skip message carries the diagnosis and names the
fix, in both `gates coverage` and `gates try`:

```
– [registry] by-files  —  0 ids across 1 file(s)
    SKIPPED — matched nothing; the selector is probably stale
    → 0 edges via `to.files` — that matches an import's DIRECTLY-resolved path, so a symbol
      re-exported through a barrel/package resolves to the package entry, not the deep file.
      Target by `to.module` + `to.match` instead.
```

**Rule of thumb:** target by `module` + `match` when consumers import through a
package or barrel; target by `files` when they import the file *directly* (a
relative path, or an alias pointing at the file). `to.files` is still the right
tool inside the library itself — the barrel's own
`export { X } from './generated/X'` is a relative import and resolves exactly
where you expect.

### `emit` — one extractor, four rule shapes

| `emit` | id | Rule shape it enables |
|---|---|---|
| `edge` (default) | `apps/a.ts → NgeAlphaView` | **adoption ledger** (`baseline`, `two-way`) — a LOST edge is a silent de-adoption; **targeted fence** (see below) |
| `symbol` | `NgeAlphaView` | **orphan detection** (`wiring`: declared = generated symbols, registered = imported symbols) — dead generated code a byte-drift gate cannot see |
| `from` | `apps/a.ts` | **deprecation ratchet** (`baseline`, `additions-only`) — any NEW importer fails |

> **Direction, precisely.** `additions-only` means *gained entries fail*;
> `no-shrink` means *lost entries fail*. A deprecation ratchet — "no new
> importer" — is therefore `additions-only`.

### The targeted fence, and `expectEmpty`

"These two subtrees must not be graph-connected" is a baseline over an empty
edge set:

```ts
{
  id: 'fence-a-to-b',
  baseline: 'baselines/fence.json',              // committed as []
  compute: {
    kind: 'extractor',
    source: { files: ['appA/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } },
  },
  direction: 'additions-only',
  expectEmpty: true,
}
```

`expectEmpty` inverts the [loud-skip contract](gate-rules.md#the-loud-skip-contract)
for this rule and only this rule. A fence ASSERTS emptiness, so a zero match is
its verified pass — without it the rule could never be green and could not gate
anything. A non-empty result is still drift, so the assertion keeps its teeth,
and `expectEmpty` with `failOnEmpty` is refused at load (they assert opposites).

### What it resolves, honestly

- **Alias-aware.** Bare specifiers go through the tsconfig `paths` map — the
  same resolution `check boundaries` uses.
- **Every dependency form counts**: `import … from`, `export … from` (a barrel
  that hid its consumers would hide the graph), side-effect `import '…'`,
  dynamic `import('…')`, and `require('…')`. A fence that missed
  `await import('../secret')` would have a hole exactly where a motivated
  person would put one.
- **The exported name, not the local alias.** `import { X as Y }` reports `X`;
  a ledger keyed by the consumer's own alias would drift on a rename that says
  nothing about the dependency.
- **No stale-graph risk.** It resolves the files the caller already walked;
  there is no persisted index behind it, so there is no staleness question to
  get wrong.
- **It does not follow a re-export chain** to attribute a symbol to its original
  module — a barrel is reported as the module the consumer actually names. Use
  `to.files` when you need the resolved path. This is a lexer's honest answer.
- **TS/JS.** Other languages are covered by the content-based extractors.

## What the lexer handles (and what it doesn't)

Handled, because these are the shapes that defeat a naive regex:

- **Wrapped literals** — `export const ALL = Object.freeze([ … ])`, and typed
  forms like `const ALL: readonly T[] = [ … ]`. A registry array is nearly
  always wrapped; missing that would silently extract nothing.
- **Section comments inside a literal** — a `// grouped section` line before an
  element does not swallow the element that follows it, and the reported line is
  the element's, not the comment's.
- **Nested literals and strings** — commas and brackets inside `f({a, b})`,
  `'lit,eral'` or `[n1, n2]` never mis-split the element list. A nested literal
  contributes no id of its own; inventing one would be a fabricated match.
- **Re-export aliases** — `export { local as Public }` reports `Public`, the name
  importers actually see.

Documented limits:

- A **regex literal** whose body contains `//` or `/*` is read as a comment.
- **`#`-comment languages** are scanned as plain code.
- `json-path` covers **JSON, not YAML** — a hand-rolled YAML reader would be a
  silent-wrong-answer risk, and a wrong answer here is worse than no rule.
- `json-path` line numbers are resolved by locating the id's first quoted
  occurrence: exact when the id is unique, honestly approximate when it is not.

## Legacy sugar

`pattern` is sugar for `extract: 'regex-capture'`; `arrayProperty` is sugar for
`extract: 'array-members'` with that anchor. Both keep working. Spelling a kind
out alongside its own sugar field is fine; setting two **different** modes is a
configuration error caught at config load, with the field path.

## Seeing what a source extracted

Never guess. Every plane has an explain verb, and
[`shrk gates`](gate-rules.md) spans all of them:

```bash
shrk gates explain <ruleId>     # files matched, ids extracted with file:line, the diff
shrk gates coverage             # every rule + its match count; flags every rule matching 0
shrk gates check                # every plane's VIOLATION check, one exit code
shrk gates try --rule-file ./candidate.json     # dry-run a rule of ANY plane, no config write
shrk gates try --wiring 'declared=<glob>:<pat> registered=<glob>:<pat>'
```

A source that matches nothing is a **bug in the source**, never a pass — see
[the loud-skip contract](gate-rules.md#the-loud-skip-contract).
