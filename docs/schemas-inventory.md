# Schema inventory (R39)

SharkCraft ships ~200 internal `sharkcraft.<id>/v<N>` envelope schemas
plus ~36 hand-written JSON schemas under `shrk schemas list`. Several
envelope schemas have been versioned (e.g. `self-config-doctor` shipped
v2 in R38 while keeping v1 for downstream consumers). Before R39 you
had to grep the codebase to find out.

`shrk schemas inventory` is the canonical answer to "what versions of
this schema have ever shipped, and which one is current?".

## Commands

```bash
shrk schemas inventory                                  # full inventory (text)
shrk schemas inventory --format markdown                # render markdown table
shrk schemas inventory --format json                    # machine-readable
shrk schemas inventory --multi-version-only             # only ids with >1 version
shrk schemas inventory sharkcraft.self-config-doctor    # one schema id
```

## Per-entry fields

- `id` — schema id (e.g. `sharkcraft.self-config-doctor`).
- `versions[]` — every version that has ever shipped, each with status
  `current` | `backcompat-only` | `deprecated` and an optional note.
- `currentVersion` — the version the engine emits by default.
- `summary` — one-line description.
- `emittedBy` — the CLI command that emits this schema (best-effort).
- `docs` — pointer to a deeper doc when one exists.

## Schema

`sharkcraft.schema-inventory/v1`.

## MCP

- `get_schema_inventory` — read-only. Pass `id` for one entry only.

## How it stays in sync

The inventory is curated, not derived. Adding a new schema or bumping
a version means updating `packages/inspector/src/schema-inventory.ts`.
Tests assert every entry's `currentVersion` matches a version in its
`versions[]` array, every entry has a non-empty summary, and engine
purity (no project-specific strings).
