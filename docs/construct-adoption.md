# Construct adoption

After `shrk constructs infer --write-drafts` produces
`sharkcraft/construct-drafts/constructs.draft.ts`, you can use the
adoption workflow to classify the drafts and produce a pseudo-patch for
human review. **SharkCraft never modifies `sharkcraft/constructs.ts`
automatically.**

## CLI

```bash
shrk constructs adopt                       # dry-run: classify each draft
shrk constructs adopt --json                # machine-readable plan
shrk constructs adopt --write-patch         # write under construct-drafts/adoption/
shrk constructs adopt --confidence high     # restrict to high-confidence drafts
shrk constructs adopt --include facets,publicApi,events,tokens
shrk constructs adopt status                # summary of the latest plan
shrk constructs adopt review                # Markdown render of the latest plan
shrk constructs adopt diff                  # line-level diff vs live constructs.ts (R14)
shrk constructs adopt diff --format markdown
shrk constructs adopt diff --format html    # JS-free, dark-mode aware
shrk constructs adopt diff --format json    # for CI gates
```

## Live diff (R14)

`shrk constructs adopt diff` answers "if I copied the adoption patch into
`sharkcraft/constructs.ts` today, what would change?" — block by block,
line by line. It reads the current `constructs.ts` (when present) and
compares it against the drafts:

- **new-construct** — id not in the live registry.
- **field-added** — same id, but the inferred entry adds files / publicApi /
  events / tokens.
- **field-conflict** — same id, but the inferred title differs.
- **already-covered** — purely informational.
- **conflict** — same id, different `type` (highlighted in yellow).

The HTML format renders side-by-side colored diff lines with no JavaScript
and works in dark mode. The MCP tool `get_construct_adoption_diff` returns
the same payload server-side (read-only).

## Classification

| Category | When |
|---|---|
| `safe-to-adopt` | New id, confidence ≥ `--confidence` (default medium → high). |
| `manual-review` | New id with medium confidence, or existing id needing merge. |
| `low-confidence` | Below threshold — keep iterating with `shrk constructs infer`. |
| `already-covered` | Existing construct with identical files. |
| `conflict` | Existing id with a different `type`. |

## Files written by `--write-patch`

```
sharkcraft/construct-drafts/adoption/
  construct-adoption-plan.md       # Markdown render of the plan
  construct-adopt.patch            # Pseudo-patch grouped by category
  construct-adopt-summary.json     # Summary counts for CI gates
```

These are advisory drafts. To adopt entries, copy them into
`sharkcraft/constructs.ts` yourself.

## MCP (read-only)

- `create_construct_adoption_plan` — same payload, no writes.
- `get_construct_adoption_review` — current status + paths + summary.
