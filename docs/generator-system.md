# Generator system

The generator is **plan-first**: every `shrk gen` call produces a `GenerationPlan` with `FileChange` items, and a write requires both `--write` and a clean plan.

## Flow

1. Resolve template by id.
2. Build name-derived variable defaults (kebab/pascal/camel/snake/className/fileName).
3. Validate variables.
4. Render template files.
5. For each file:
   - Refuse paths outside the project root (→ `conflict`).
   - If the file does not exist → `create`.
   - If it exists: consult the overwrite strategy.
6. Build the plan; if `write` is false, return the plan only.
7. If `write` is true and there are no conflicts: write each file (creating parent dirs as needed).

## FileChangeType

- `create` — new file, will be written on `--write`.
- `update` — existing file, will be overwritten on `--write` if strategy is `overwrite`.
- `skip` — file contents are identical; no action needed.
- `conflict` — refuses to write; user must resolve.

## OverwriteStrategy

- `never` (default) — refuse to write if the target exists.
- `ask` — record as conflict (the runtime that calls the generator decides how to ask).
- `overwrite` — write; equivalent to passing `--force`.
- `merge-later` — record as conflict; intended for future smarter merge.

## Naming

`buildNameVariables('user-profile')` produces:

```
kebab: user-profile
pascal: UserProfile
camel: userProfile
snake: user_profile
className: UserProfile
fileName: user-profile
```

These are merged with the user's `--var key=value` flags before validation.

## Inspecting & validating before apply

- `shrk gen --print` (alias of `--show-content`) renders the file bodies inline,
  so you inspect exactly what would be written in one step.
- `shrk gen --typecheck` compiles the emitted **create** files (`.ts` / `.tsx`)
  against the **detected `tsconfig`** *in memory*, before apply. It is a
  **pre-write gate**: the check runs on a dry-run render FIRST, so a
  project-template bug fails at **generation time** (exit `1`) and — with
  `--write` — the write is **refused** (`writeRefused: true`, nothing lands on
  disk) instead of surfacing at the human's next build. Only diagnostics **in the
  emitted files** are reported — pre-existing errors elsewhere don't fail the run.
