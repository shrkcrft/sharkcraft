Follow `.claude/skills/sharkcraft-dev/SKILL.md` from the first line.

# Round: agent-feedback-fixes

## Source

Verbatim feedback from a Claude agent using `shrk` in a downstream
repository (paraphrased):

> Real friction:
> - `npx shrk` 404s on the public registry — only `bunx shrk` works
>   locally. That's a distribution problem, not a tool-value problem,
>   but it makes onboarding awkward and CI fragile if you're not on bun.
> - The pack at `tools/sharkcraft-pack/` is now the source of truth, but
>   the legacy `tools/cli/` knowledge base is frozen rather than removed
>   — two places to think about until the migration finishes. *(This is
>   an issue in the consumer repo, not this one — out of scope here.)*
>
> What's mid:
> - `shrk doctor` AI-readiness scoring (71/100, 367 action-hint warnings)
>   is mostly nag — useful direction, but not painful to ignore.
> - Per-file boundary feedback is nicer in CI than in the inner loop. You
>   probably wouldn't miss it day to day.

## Goal

Address the three engine-side issues:

1. **`npx shrk` 404** — the unscoped `shrk` package name is not published
   on npm. Ship a thin wrapper package so `npx shrk@alpha` and
   `npx shrk` resolve.
2. **Doctor nag** — `actionhints-*` warnings dominate the default
   headline. Collapse them to a one-line summary unless the user opts
   in (`--show-quality` or similar), keeping `--strict=all` behavior
   intact for CI.
3. **Boundary inner-loop UX** — add `--watch` to `shrk check
   boundaries` (or its polyglot sibling `shrk boundaries enforce`),
   mirroring the watch helper `shrk doctor --watch` already uses.

Also:
- Update `README.md` quickstart to show `npx shrk@alpha` alongside
  `bunx shrk@alpha`.
- Update `CHANGELOG.md` Unreleased section.

## Out of scope

- The downstream repo's `tools/cli` migration.
- Republishing or pushing `dist-tags` — that's a release step the
  developer runs manually with `bun run publish:packages`.

## Acceptance

- `packages/shrk/` exists with `name: "shrk"`, a `bin: "shrk"`, and a
  runtime stub that imports the same main entry as `@shrkcrft/cli` (no
  code duplication; depend on `@shrkcrft/cli` and re-export).
- `shrk doctor` default output suppresses `actionhints-*` warnings into
  a one-line collapsed summary; a new flag re-enables the full list;
  `--strict=warnings` keeps excluding hint-quality (existing behavior);
  `--strict=all` still counts them (existing behavior).
- `shrk check boundaries --watch` exists, debounces, and re-runs on
  edits to `**/*.ts` (or the polyglot file globs).
- Tests pass (`bun test`), typecheck passes (`bun x tsc -p tsconfig.base.json --noEmit`).
