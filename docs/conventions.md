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
`verdict` is the engine's `clean` / `has-violations`, and `not-verified` at `2` —
never `clean` beside a NOT VERIFIED exit):

| Exit | When |
|---|---|
| `0` | every file in scope checked against every loaded convention, no `error`-severity hit (warning / info hits are listed, never failing) |
| `1` | an `error`-severity hit |
| `2` NOT VERIFIED | nothing to check: **no file in scope** (no working-tree change, an empty `--since` / `--staged` diff), **no convention declared**, or a **convention file that never loaded** (its conventions were never checked) |
| `3` | a usage error — an unknown flag (`--bogus`). `--strict` is not one here: it is the global promoter, turning a `2` into a `1` |

`--allow-empty` accepts the first two explicitly — the acceptance is printed,
never silent — and never the third: an unread convention file is a file with
conventions nobody checked. Before round 13 an empty scope printed `ok — no
violations.` at exit `0`, which read like a pass over nothing.

## Shape

```ts
interface IConvention {
  id: string;
  title: string;
  description?: string;
  kind: 'path' | 'naming' | 'barrel' | 'layout' | 'command' |
        'validation' | 'ownership' | 'testing' | 'release' | 'safety';
  appliesTo?: { languages?: ...; frameworks?: ...; fileGlobs?: ...;
                constructKinds?: ...; profileIds?: ... };   // profileIds: WorkspaceProfile ids
  rules: { id, description, expectMatch?, forbidMatch?, filePattern?,
           severity? }[];
  examples?: { description, good?, bad? }[];
  references?: { kind: 'file' | 'doc' | 'command' | 'knowledge' | 'rule'; value }[];
  severity: 'info' | 'warning' | 'error';
  tags?: string[];
}
```

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
  `filePattern` that does not compile, an `appliesTo` list that is not a list.

**Warnings** — the convention still loads, reported as `convention-shape`: an
unknown top-level key, a rule without a string `id` / `description`, a
reference without a `value`, a non-array `tags` / `examples`.

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
  read-only.

## Schemas

- Convention shape: described by `IConvention` (no schema marker).
- Registry: `sharkcraft.convention-registry/v1`.
- Check report: `sharkcraft.convention-check/v1`.
