# Plan review

`shrk plan review <plan.json>` inspects a saved generation plan
(`sharkcraft.plan/v1` JSON) and reports:

- Template id (when known).
- Files the plan would create/update/skip/conflict on.
- Signature status (`absent`, `present + verified`, `invalid`).
- Affected path conventions.
- Missing-tests heuristic (`src/x.ts → tests/x.spec.ts`).
- Boundary concerns for those files (against the current state).
- Verification commands recommended after `shrk apply`.
- Human-approval reminder.

```bash
shrk plan review ./.sharkcraft/plans/plan.json
shrk plan review ./plan.json --json
```

MCP: `review_generation_plan`. Read-only. Apply still requires the human
to run `shrk apply <plan> --verify-signature` on the CLI.

`shrk dev plan <id>` automatically runs plan review on every plan it saves
into a session, dropping the JSON + Markdown reports under
`.sharkcraft/sessions/<id>/reports/plan-review-*.{json,md}`. See
[`docs/dev-workflow.md`](./dev-workflow.md).

## Plan-aware boundary check

`plan review` reads the saved plan, re-renders the template against the
current registry to recover file contents, scans the **planned** file
contents for imports, and evaluates boundary rules as if those files
existed at their planned paths. Output separates:

- `Boundary concerns (current state)` — existing violations on the same
  paths.
- `Boundary concerns introduced by this plan` — violations the plan
  would *add* by writing the planned contents.

Each entry includes the rule id, the import specifier, line number,
matched-forbidden pattern, `resolvedVia` (when the match came through
tsconfig alias resolution), and the rule's `suggestedFix`.

## `shrk apply --validate`

Pair plan review with the validation loop on apply:

```bash
shrk apply ./plan.json \
  --verify-signature \
  --validate \
  --command "bun test" \
  --report
```

The loop:

1. Verifies signature (`--verify-signature`).
2. Applies files.
3. Runs the explicit `--command` (if supplied).
4. Re-runs the boundary scan and surfaces violations as warnings.
5. Writes a JSON report to `.sharkcraft/reports/` if `--report` is set.

### Verification commands from `sharkcraft.config.ts`

Define repeatable verification commands in your project config:

```ts
// sharkcraft/sharkcraft.config.ts
export default {
  verificationCommands: [
    { id: 'typecheck', command: 'bun x tsc -p tsconfig.base.json --noEmit', trusted: true },
    { id: 'test',      command: 'bun test',                                  trusted: true },
  ],
};
```

Then opt in by id (or all of them) on apply:

```bash
shrk apply plan.json --validate --verification typecheck --verification test
shrk apply plan.json --validate --all-verifications
```

Selecting an unknown `--verification <id>` fails with a clear error.

`--validate-strict` (or `--strict`) fails the run on warnings.
`--allow-pack-commands` reserves a future opt-in for pack-contributed
verification commands — **v1 only runs commands from local
`sharkcraft.config.ts` or the explicit `--command` flag**, never
commands sourced from packs.

## v2 plan kinds (R22)

A saved plan can carry the v2 operation kinds: `create`, `update`, `append`,
`insert-after`, `insert-before`, `replace`, `export`, plus `skip` and
`conflict`. As of R22, `shrk plan review` surfaces every v2 kind explicitly
instead of collapsing them to `unknown`, and each entry that modifies an
existing file is annotated `[modifies existing]`. The output also includes
summary counts (`creates`, `modifies existing`, `conflicts`) and a
`HUMAN REVIEW REQUIRED — N entry/entries modify existing files.` line when
N > 0. See `packages/inspector/src/plan-review.ts`.
