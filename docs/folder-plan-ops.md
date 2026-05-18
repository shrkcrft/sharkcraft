# Folder plan operations (R33 + R34 + R35)

SharkCraft can plan **and apply** `rename-folder` / `delete-folder`
operations behind strict safety gates.

## Plan emission

`shrk plugin rename <old> <new> --profile <id> --emit-folder-ops` and
`shrk plugin remove <name> --profile <id> --emit-folder-ops` attach a
structured `folderOps[]` array to the plan. Each op carries a safety
verdict (`safe | unsafe`) computed by `checkFolderOpSafety`.

Without `--emit-folder-ops` the plan still emits the equivalent manual
checklist — the existing R28+ behaviour.

## Apply

`applyFolderOps()` in `@shrkcrft/generator` executes the operations.
The default is **dry-run**; mutating execution requires:

- `allowFolderOps: true` (CLI: `--allow-folder-ops`),
- and for delete-folder, additionally `allowDeleteFolder: true` (CLI:
  `--allow-delete-folder`).

The applier rejects each operation **before** touching the filesystem if:

- the target resolves outside the project root,
- the target sits inside `.git`, `node_modules`, `.svn`, or `.hg`,
- the target equals the project root, home directory, or `/`,
- delete-folder is requested without the explicit allow flag,
- rename-folder source does not exist or destination already exists.

## Schemas

- Folder op shape: part of `sharkcraft.plugin-lifecycle/v1` (R32+).
- Apply report: `sharkcraft.folder-op-apply/v1`.

## R35 — Apply pipeline integration

Folder ops now flow through the standard `shrk apply` pipeline as part of
a saved plan (`sharkcraft.plan/v2`):

```ts
ISavedPlan.folderOps?: ISavedPlanFolderOp[];
```

The HMAC signature covers `folderOps[]` (canonical-JSON includes the
field). Apply:

1. Reads the saved plan and verifies signature (`--verify-signature`).
2. Diffs file ops + folder ops against the live state (divergence
   detection via `diffPlanChanges` + `diffPlanFolderOps`).
3. Runs `checkFolderOpSafety` on every folder op **before** any FS write.
4. Refuses the whole plan if any folder op is unsafe OR if the matching
   allow flag is missing (mixed file+folder plans fail-fast).
5. Executes file ops via the existing generator engine; then executes
   folder ops via `applyFolderOps`.

`shrk plugin rename / remove --save-plan <file>` produces a saved plan
with `templateId: __plugin-lifecycle__`. The apply command recognises the
synthetic templateId, skips the template lookup, and evaluates each
saved replace op against the live file system.

### Apply exit categories (R35 additions)

- `blocked-folder-op-allow-flag` — `--allow-folder-ops` (or
  `--allow-delete-folder` for delete-folder) is missing.
- `blocked-folder-op-unsafe` — at least one op resolves to an unsafe
  path (handled before any write).

## Tests

`r34-feature-accelerator.test.ts > R34.1` covers safety verdicts.
`r35-feature-accelerator.test.ts > R35 — saved plan folder ops` covers:

- saved-plan signature carries folder ops verbatim,
- divergence detection for added/removed folder ops,
- synthetic plan evaluation against live files,
- `.git` rejection (from R34),
- outside-project rejection,
- delete-folder rejection without flag,
- safe rename acceptance,
- apply without the flag rejected,
- apply with the flag executed,
- apply delete with both flags executed.
