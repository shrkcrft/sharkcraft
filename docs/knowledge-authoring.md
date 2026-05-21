# Knowledge authoring (R44 + R52)

`shrk knowledge add | update | remove | lint` give agents a structured,
**preview-only** way to evolve project knowledge without hand-editing
`sharkcraft/knowledge.ts` or a pack's `assets/knowledge.ts`.

R52 extends this surface for parity:

- **Rules** (knowledge entries with `type='rule'`) now expose the same
  triple: `shrk rules add | update | remove`. The add/remove verbs are
  thin wrappers — `rules add` forces `type='rule'`, `rules remove`
  refuses non-rule ids and delegates to `knowledge remove`. Same flag
  shape, same preview path, same provenance.
- **Templates** (TS-shaped, not knowledge entries) gain `shrk templates
  update | remove`. The drafts land under
  `.sharkcraft/authoring/templates/` and the remove verb refuses when
  pipelines / presets / knowledge / packs reference the template.

See [pack-authoring.md](./pack-authoring.md) for templates parity and
[doctor.md](./doctor.md) for the `--blockers` triage flag.

R53 added in-place apply paths for stale references; R54 upgraded
the default to **rename in place** when the engine can identify the
new location:

```bash
shrk fix --knowledge-stale --apply                  # rename when engine has a replaceWith;
                                                    # do nothing otherwise (no destructive default)
shrk fix --knowledge-stale --apply --drop-stale     # also drop outcome=stale refs without replaceWith
shrk fix --knowledge-stale --apply --drop-missing   # also drop outcome=missing refs without replaceWith
```

R54 contract:

- For symbol references where the symbol exists with the same name in
  exactly one other file under `packages/`, the stale-check emits a
  structured `replaceWith: { path: '<new path>', rationale }` on the
  check. The apply path uses this to migrate the reference (rewrite
  `path`) rather than drop it.
- When `replaceWith` is ambiguous (multiple candidate files) or
  absent (no candidates), the apply falls back to drop — but only
  when the explicit `--drop-stale` / `--drop-missing` flag is set.
- Provenance records `applied: 'rename'` vs `applied: 'drop'` so the
  ledger distinguishes migrations from removals.

R55 extends the rename signal to file and directory references:

- For `kind: 'file'` references whose path no longer exists, the
  stale-check looks up the basename across `packages/`, `sharkcraft/`,
  `docs/`, and `examples/`. If exactly one candidate matches the
  basename AND shares ≥1 parent-directory segment with the stale
  path (so a directory move propagates), `replaceWith: { path }` is
  emitted with `rationale: "File basename ... resolves uniquely to
  ... (likely directory rename)"`.
- For `kind: 'directory'` references, the same heuristic applies to
  directory basenames.
- Ambiguous (multiple candidates) or unrelated (zero overlapping
  parent segments) matches still decline the rename and fall back
  to drop.

R55 also changes the `knowledge rename-symbol|rename-file|update-anchor`
verbs to be **read-only**: the pre-R55 `--write` flag wrote a patch
file under `sharkcraft/knowledge-updates/` that no consumer applied.
To land entry-side renames, run `shrk fix --knowledge-stale --apply`
— the engine's `replaceWith` signal carries the migration target.
Source-side symbol rename remains out of scope until an AST-aware
path exists.

See [lint.md](./lint.md) for the unified `shrk lint` entry point.

## Hard guarantees

- Every command defaults to preview-only. Nothing is written to source
  unless an explicit `--write-preview` flag is passed.
- `--write-preview` only writes under `.sharkcraft/authoring/` (drafts +
  manifest + explainer) or `.sharkcraft/fixes/` (lint output). It never
  mutates `sharkcraft/knowledge.ts` and never touches pack source.
- No new MCP write tools were added in R44. Authoring lives on the CLI
  exclusively.
- Pack edits to `assets/knowledge.ts` still make the signature stale —
  re-sign manually via `shrk packs sign --if-needed` once
  `SHARKCRAFT_PACK_SECRET` is available.

## Commands

```bash
# Preview adding a new entry. Refuses if the id already exists.
shrk knowledge add --id <id> \
  [--title <t>] [--type <type>] [--priority critical|high|medium|low] \
  [--summary <s>] [--content <text>] \
  [--scope x,y] [--tag x,y] [--applies-when x,y] \
  [--related a,b] \
  [--reference kind:value[:required]]  (repeatable) \
  [--reason <text>] \
  [--allow-overwrite] [--write-preview] [--json]

# Preview an incremental update to an existing entry.
shrk knowledge update <id> \
  [--summary <s>] [--content <text>] [--priority ...] \
  [--add-related a,b] [--remove-related a,b] \
  [--reference kind:value[:required]] (repeatable) \
  [--remove-reference kind:value] (repeatable) \
  [--remove-anchor-id <id>] (repeatable) \
  [--mark-deprecated] [--unmark-deprecated] \
  [--reason <text>] [--write-preview] [--json]

# Preview removal. Refuses if reverse references exist; suggest
# deprecation as a safer alternative.
shrk knowledge remove <id> \
  [--force-preview] [--reason <text>] [--write-preview] [--json]

# Lint — classify findings without fabricating prose.
shrk knowledge lint \
  [--id <entryId,...>] [--fix-preview] [--write-preview] \
  [--no-advisory] [--json]

# R48 — `shrk knowledge author` (dispatcher alias) was removed; call
#       `knowledge add|update|remove` directly.
```

## What gets written

When `--write-preview` is passed and the operation is accepted, three
files land under `.sharkcraft/authoring/`:

| File | Purpose |
| --- | --- |
| `knowledge-<op>-<id>.draft.ts` | Pasteable TypeScript literal for the knowledge file. |
| `knowledge-<op>-<id>.manifest.json` | Machine-readable manifest (planned shape, warnings, patch). |
| `knowledge-<op>-<id>.md` | Markdown explainer + next-commands list. |

A provenance entry is appended to `.sharkcraft/asset-provenance.jsonl`
recording the operation, asset id, reason, source (`cli` or `agent`),
session id (if available), author (`$SHARKCRAFT_AUTHOR` / `$USER`), and
the path of the draft. See [`asset-provenance.md`](./asset-provenance.md).

## Reference grammar

`--reference` accepts a compact `kind:value[:required]` form:

| Kind | Form | Example |
| --- | --- | --- |
| `file` / `directory` | `file:<path>` | `file:packages/cli/src/main.ts` |
| `symbol` | `symbol:<name>` | `symbol:CommandRegistry` |
| `command` / `template` / `playbook` / `construct` / `helper` / `policy` / `boundary-rule` / `path-convention` / `package` / `url` | `<kind>:<id>` | `template:app.service` |

Append `:required` to mark the reference as required for stale-check.

## Lint categories

`shrk knowledge lint` classifies every finding into one of:

| Category | Meaning |
| --- | --- |
| `safe-mechanical-stub` | Carries a deterministic stub (e.g. derived summary). Safe to apply mechanically. |
| `needs-human-wording` | Body / summary placeholder or too short — requires human prose. |
| `should-acknowledge` | Intentional gap — e.g. an entry with no `appliesWhen`. |
| `obsolete-entry` | `metadata.deprecated = true`. |
| `stale-reference` | One of the entry's references is stale or missing. |
| `missing-provenance` | No authoring metadata — advisory. |
| `missing-action-hints` | High-priority entry with no `actionHints` — advisory. |

`--fix-preview` partitions findings into:
- `safeStubs` (always have a non-empty suggestion),
- `todos` (no suggestion — human wording required),
- `acknowledgements` (intentional / advisory).

Stub suggestions are *never* meaningful prose — they are explicit
TODO markers (e.g. `TODO(summary): one-line summary of "<title>".`)
designed for an agent or human to fill in.

## Next commands after authoring

Every successful preview prints (and stores in the explainer) the
follow-up commands:

```
$ shrk knowledge stale-check --ci
$ shrk self-config doctor
$ shrk packs signature-status
$ # Pack edits make signatures stale — see `shrk packs sign --print-command`
```

## Why preview-first

Direct mutation of `sharkcraft/knowledge.ts` (or a pack's `assets/knowledge.ts`)
has two failure modes R44 explicitly avoids:

1. **Format drift.** Hand-editing inside an `export default [...]` array
   is error-prone; the draft TS file is a fresh literal that copies
   cleanly.
2. **Signature laundering.** If `shrk` mutated pack source directly, it
   could re-sign in the same step — laundering the change. R44 keeps the
   mutation step explicit (a paste) so the signature genuinely goes
   stale and the human controls the re-sign.

## Schemas

- `sharkcraft.knowledge-authoring/v1`
- `sharkcraft.knowledge-authoring-patch/v1`
- `sharkcraft.knowledge-lint/v1`
- `sharkcraft.knowledge-lint-fix-preview/v1`
