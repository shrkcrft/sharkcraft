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

### Shared fields

| Field | Meaning |
|---|---|
| `files` | Project-relative globs (`**`, `*`, `?`). Required. |
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
shrk wiring test ./candidate.json   # dry-run a rule before committing it to config
```

A source that matches nothing is a **bug in the source**, never a pass — see
[the loud-skip contract](gate-rules.md#the-loud-skip-contract).
