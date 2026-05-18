# Asset provenance (R44)

R44 added a local, append-only **asset-provenance** ledger at:

```
.sharkcraft/asset-provenance.jsonl
```

Each line is a JSON object with schema `sharkcraft.asset-provenance/v1`.

## What goes in

Authoring commands (`shrk knowledge add/update/remove --write-preview`,
later: pack author preview verbs for other kinds) append one entry per
preview. Fields:

| Field | Meaning |
| --- | --- |
| `schema` | always `sharkcraft.asset-provenance/v1` |
| `generatedAt` | ISO timestamp |
| `operation` | `add` / `update` / `remove` / `preview` / `apply` / `acknowledge` |
| `assetKind` | `knowledge` / `search-tuning` / `feedback-rule` / ... |
| `assetId` | id of the asset being authored |
| `targetFile` | project-relative path the human would edit (optional) |
| `source` | `manual` / `agent` / `cli` / `session` / `unknown` |
| `sessionId` | from `$SHARKCRAFT_SESSION_ID` or `$CLAUDE_CODE_SESSION` (optional) |
| `bundleId` | for future feature-bundle integration (optional) |
| `reason` | free-text `--reason` passed by the caller (optional) |
| `relatedTask` | optional task / branch / issue id |
| `author` | from `$SHARKCRAFT_AUTHOR` or `$USER` (optional) |
| `previewPath` | path of the draft TS file |
| `patchPath` | path of an emitted patch file (optional) |
| `extra` | small structured payload (e.g. `{ authoringOp: 'update' }`) |

## Hard guarantees

- **Local only.** The ledger lives entirely under `.sharkcraft/`. The
  recorder refuses to write outside `.sharkcraft/asset-provenance.jsonl`.
- **No telemetry.** No network calls. No upload. The ledger is just a
  diary the project owns.
- **Append-only.** Existing entries are never rewritten. A corrupt line
  is tolerated on read (skipped) — the JSONL format keeps the rest of
  the ledger readable.
- **Not load-bearing.** Doctor / lint may *recommend* adding provenance
  to a recent entry, but existing entries without a provenance trail
  are not failures.

## CLI

```bash
shrk provenance list [--kind <k>] [--id <id>] [--operation <op>] [--limit N] [--json]
shrk provenance show <assetId> [--kind <k>] [--json]
shrk provenance report [--recent N] [--json]
```

Schemas:
- `sharkcraft.asset-provenance/v1` — one ledger entry.
- `sharkcraft.asset-provenance-report/v1` — `shrk provenance report`.

## Auto-detection

The CLI reads:

- `$SHARKCRAFT_AGENT`, `$CLAUDE_CODE_SESSION`, or `$ANTHROPIC_AGENT` →
  source = `agent`.
- otherwise → source = `cli`.
- `$SHARKCRAFT_SESSION_ID` (or `$CLAUDE_CODE_SESSION`) → recorded as
  `sessionId`.
- `$SHARKCRAFT_AUTHOR` (else `$USER`) → recorded as `author`.

## When to look here

- "Who/why added this knowledge entry?" → `shrk provenance show <id>`.
- "How many knowledge entries have I authored this week?" →
  `shrk provenance list --kind knowledge --limit 50`.
- "Is this pack signed but the knowledge added last week never got an
  apply trail?" → `shrk pack-author pending` includes pending provenance
  entries; cross-check with `shrk provenance show <id>`.

## What the provenance ledger is NOT

- It is not a substitute for git history. Git is authoritative for what
  *landed*; the provenance ledger is what *was authored* — including
  previews that never made it to source.
- It is not a runtime registry. Nothing consumes the ledger to drive
  the engine. It is purely diagnostic / explanatory.
- It is not signed. There is no HMAC on `asset-provenance.jsonl`; it is
  local diary data and a hostile attacker with write access to
  `.sharkcraft/` can already alter the workspace however they like.
