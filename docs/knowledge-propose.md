# `shrk knowledge propose`

R58. AST-driven inference of stub knowledge entries for exported
top-level constructs that lack an existing knowledge entry.

Closes the authoring loop: when you add a new exported class, function,
interface, type, enum, or const, run `knowledge propose` to get a
ready-to-edit draft entry instead of writing one by hand.

## Synopsis

```bash
shrk knowledge propose [--path <file>] [--symbol <name>] [--since <ref>|--all] [--json] [--write]
```

## What gets proposed

For each exported top-level binding that is **not** already covered by
an entry's `references[]` (symbol or file kind) or `anchors[]`, the
engine generates a stub entry:

- `id`: derived from `<package>.<kebab-symbol-name>`
- `title`: `"<Symbol> (<kind>, proposed)"`
- `type`: `technical`
- `priority`: `medium`
- `scope`: `[<package>, <feature>]`
- `summary` + `content`: scaffolded with a "replace this with the
  *why*" instruction
- `references`: `[{ kind: 'file', path, required: true }, { kind: 'symbol', symbol, path }]`

## Flags

| Flag | Meaning |
|------|---------|
| `--path <file>` | Restrict scan to a single file. |
| `--symbol <name>` | Propose only for the named symbol (within `--path`). |
| `--since <ref>` | Scan files changed since this git ref. Default `HEAD`. |
| `--all` | Scan the whole workspace, ignoring git-changed status. |
| `--json` | Emit `IKnowledgeProposeReport` (schema `sharkcraft.knowledge-propose/v1`). |
| `--write` | Materialise drafts as `.sharkcraft/authoring/proposed/<id>.ts` + `_manifest.json`. |

## Preview vs write

Default = preview. Nothing is written. The output lists every proposal
+ every skip (with reason: `already-covered`, `excluded`,
`unsupported-kind`, `default-export-skipped`, `not-selected`).

With `--write`, the engine writes one `.ts` per proposal under
`.sharkcraft/authoring/proposed/`. Each file exports a single object
literal you can paste into your canonical knowledge module (e.g.
`sharkcraft/knowledge.ts`). The `_manifest.json` records every
generated draft so the write can be replayed.

## MCP

`preview_knowledge_propose` is the read-only sibling. Same payload
shape as `--json`; never writes. Tier-gated through the R56 sibling
mechanism (`cliCommand: 'knowledge propose'`).

## Exclusions

The scan skips `__tests__/`, `.test.`, `.spec.`, `*.d.ts`,
`node_modules/`, `dist/`, `coverage/`, and `.sharkcraft/`.

## Related

- `shrk knowledge add` — manual entry authoring (R44).
- `shrk knowledge lint` — classify existing entries (R44).
- `shrk knowledge stale-check` — verify `references[]` still resolve (R29).
