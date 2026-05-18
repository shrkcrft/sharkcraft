# Plugin lifecycle helpers (R28.5)

Plan-only plugin rename / remove driven by a lifecycle profile.

## Commands

```
shrk plugin rename <old> <new> --profile <id> [--output <plan.json>] [--json]
shrk plugin remove <name>      --profile <id> [--output <plan.json>] [--json]
shrk plugin lifecycle list
shrk plugin lifecycle inspect <name>
```

## What the plan covers

| Layer | Replace op |
|---|---|
| `packages/<scope>/plugin-core/src/lib/types/feature-keys.ts` | rename / remove the entry |
| `packages/<scope>/plugin-api/src/index.ts` | swap / remove `export * from './lib/plugins/<old>'` |
| `packages/<scope>/plugin-cross/src/index.ts` | same |
| `packages/<scope>/plugin-angular/src/index.ts` | same |

## Manual steps

The plan engine has no `rename-folder` / `delete-folder` operation. The
helper emits a structured `manualSteps` list with `kind`, `targetPath`,
optional `newPath`, and a `reason` — the human runs:

```
git mv packages/<scope>/plugin-api/src/lib/plugins/<old> .../plugins/<new>
git rm -r packages/<scope>/plugin-api/src/lib/plugins/<name>
```

## Conflicts

Surfaced advisory hints when an expected anchor cannot be found
(e.g. plugin not in FEATURE_KEYS, plugin not exported from a barrel).
Conflicts do not block the plan — they document what was skipped.

## Validation commands

Every plan emits:

```
shrk check boundaries --changed-only
shrk doctor
bun x tsc -p tsconfig.base.json --noEmit
```

## MCP

`preview_plugin_rename({ oldName, newName })` and
`preview_plugin_remove({ name })` return the same plan over the
read-only MCP surface. The CLI is still the only way to save and apply.

## Safety

- Both commands are plan-only by default.
- Remove is destructive — `humanApprovalRequired: true` is always set.
- File deletes/renames are manual checklist items, never auto-executed.
- The MCP tools are read-only previews.
