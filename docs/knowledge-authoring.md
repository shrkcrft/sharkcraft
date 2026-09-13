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
# deprecation as a safer alternative. "Reverse references" means EVERY
# declared cross-reference (round 11): another entry's related / seeAlso /
# supersededBy / actionHints.relatedKnowledge, a construct's relatedKnowledge /
# relatedRules / relatedPathConventions or a declared facet, a boundary rule's
# related*, a template's related — printed as e.g.
# `construct:fx-construct (relatedKnowledge)`.
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

## Group modules (round 11)

A listed knowledge / rules / paths / templates file registers EVERY
entry-shaped export it has, so the simplest way to split a large file is to
re-export its groups: `export * from './group-a.ts'`. A hand-maintained array
(`import { a1 } from './group-a.ts'; export default [a1]`) also works, but an
entry added to the group and not to the array is invisible to every lookup —
`shrk doctor` reports it as **Unregistered entry exports** (error), naming the
export, its line and the aggregator (`detectUnregisteredExports`; one level
of the aggregator's own relative imports, no globbing). Listing the group
files directly in `knowledgeFiles` registers them too. A second, DIFFERENT
object reusing an id in one module is a loader warning
(`duplicate id "<id>" … shadowed by an earlier export`) — only the first
registers, and `shrk doctor` prints it as a **Loader warning**. (Ids repeated
ACROSS files are the validator's `duplicate-id`.)

A raw entry literal may omit `tags` / `scope` / `appliesWhen`: the TypeScript
loader normalises each to `[]` (as `defineKnowledgeEntry` does), and a non-list
value is replaced with a loader warning naming the entry and field. The
Markdown loader warns for every frontmatter key it does not carry onto the
entry — notably `metadata`, which a Markdown entry cannot hold (so a Markdown
rule cannot declare `metadata.checks[]`; see [custom-checks.md](./custom-checks.md)).

## Reference grammar

`--reference` accepts a compact `kind:value[:required]` form:

| Kind | Form | Example |
| --- | --- | --- |
| `file` / `directory` | `file:<path>` | `file:packages/cli/src/main.ts` |
| `symbol` | `symbol:<name>[@<path>]` | `symbol:CommandRegistry@packages/cli/src/command-registry.ts` |
| `symbol` (a member) | `symbol:<Owner>.<member>@<path>` | `symbol:CommandRegistry.listAll@packages/cli/src/command-registry.ts` |
| `command` / `template` / `playbook` / `construct` / `helper` / `policy` / `boundary-rule` / `path-convention` / `package` / `url` | `<kind>:<id>` | `template:app.service` |

Append `:required` to mark the reference as required for stale-check. The
stale-check prints references in the same grammar, so a line it reports can be
pasted back as a `--reference`.

### Reference shape (round 11)

`KNOWLEDGE_REFERENCE_KINDS` (`@shrkcrft/knowledge`) is THE vocabulary: the
validator, the stale-check and this grammar all read it. At load time
`shrk doctor` reports, per entry and reference:

| Code | Severity | When |
| --- | --- | --- |
| `invalid-reference` | error | a `kind` outside the vocabulary (the message lists every kind) |
| `invalid-reference` | warning | the field the kind cannot be checked without is missing — `path` (file / directory), `symbol` (symbol), `id` or `command` (command), `id` (registry kinds) |
| `reference-absolute-path` | warning | a `path` starting with `/` or a drive letter — reference paths are repo-relative (it still resolves leniently) |

The stale-check reports such a reference as **`invalid`** (failure
`malformed`) — its own outcome, not `unknown` (which stays for a well-formed
reference it cannot evaluate, like a `url`). The text prints `invalid=N`; a
malformed reference was declared to be checked and never was, so it is a
coverage shortfall on the verdict (exit `2`, NOT VERIFIED — never a pass, in
any mode), and `--fail-on invalid` makes it a failure (`1`). An entry whose
only references are malformed is UNVERIFIABLE.

### Prefer symbol pins over paths (round 11)

A `file` reference proves only that the file exists; rename the function the
entry documents and the check still passes. Pin what the entry is ABOUT:

- `symbol:<name>@<path>` — the strong form: a moved symbol is told apart from a
  deleted one, and a rename inside the file is caught.
- `symbol:<Owner>.<member>@<path>` — for a method, property, enum member,
  interface member or object key.
- Add `contains` / `matches` for a claim about contents, and `count` for a
  number the entry states (see [knowledge-integrity.md](./knowledge-integrity.md#content-assertions-round-11)).

An entry whose references are all paths while its prose names an exported
symbol of one of those files gets a `path-only-reference` advisory from
`shrk knowledge stale-check`, with the symbol reference to add. An entry with
no reference at all is UNVERIFIABLE — it keeps the stale-check off a clean
exit until it declares one (or a `--min-referenced` floor accepts it).

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
