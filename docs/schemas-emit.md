# `shrk schemas emit`

R58. Mirrors the in-memory JSON schema registry to disk so agents can
grep `docs/` for schema ids and so CI can guard against drift.

## Synopsis

```bash
shrk schemas emit [--out <dir>] [--write|--check] [--json]
```

## What gets emitted

- `<out>/<name>.schema.json` for every entry in `ALL_SCHEMAS`
- `<out>/INDEX.md` — a markdown table listing schemas + their source commands

Default `<out>` is `docs/schemas/`. The directory is auto-created on
`--write`.

## Modes

| Mode | Behaviour |
|------|-----------|
| (default) | Preview: lists files that would change. Writes nothing. |
| `--write` | Writes every schema + INDEX.md. Files left in `<out>` that are not in the registry are *not* deleted automatically — they're listed as "unexpected" so a human can decide. |
| `--check` | Exits non-zero if `<out>` is stale (missing files, changed content, or unexpected leftovers). |

`--write` and `--check` are mutually exclusive.

## Schema

Reports use `sharkcraft.schemas-emit/v1`. Stable across all three modes
(`mode: 'preview' | 'write' | 'check'`).

## Release-preflight integration

`scripts/release-preflight.ts` runs `shrk schemas emit --check` and
fails on drift. Re-emit with `shrk schemas emit --write` whenever the
in-memory registry changes (e.g. when you ship a new schema). Commit
the resulting `docs/schemas/` changes alongside the registry edit.

## Related

- `shrk schemas list` — list schema names known to the registry.
- `shrk schemas get <name>` — print one schema to stdout.
- `shrk schemas inventory` — version metadata + deprecation status.
- `shrk schemas write --dir <dir>` — pre-R58 one-shot writer. `emit` is the preferred replacement.
