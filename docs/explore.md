# `shrk explore <path>` — workspace-aware directory explanation (R39)

`shrk explore <path>` explains *one specific* directory. It's the
deterministic alternative to grepping README files, scanning imports,
and prompt-engineering an AI to summarise a folder.

```bash
shrk explore packages/cli/src/commands
shrk explore packages/mcp-server/src/tools --format markdown
shrk explore sharkcraft --format json
```

## Output

- **Inferred area kind** — `core` / `cli` / `mcp` / `plugin` / `tests`
  / …, drawn from the existing repo-wide area map.
- **Role** — one-line "what is this directory for". Special-cased for
  the well-known SharkCraft directories (e.g.
  `packages/mcp-server/src/tools` → "MCP read-only tools — must never
  write").
- **Key files** — largest source/config files in the dir (descending by
  size). Ignores `dist/`, `__tests__/`, `.d.ts`, generated output.
- **Related commands** — entries from the CLI command catalog scored by
  token overlap with the dir name.
- **Related MCP tools** — tool names scored the same way.
- **Related templates / pipelines** — from the local + pack
  registries.
- **Boundary rules / path conventions** — that mention the dir on their
  `from` side.
- **Common edit risks** — special callouts for MCP tool dirs,
  CLI write-paths, signed pack assets, missing tests, generated output.
- **Next commands** — `shrk impact --files`, `shrk check boundaries
  --files`, `shrk tests missing --area` (when no tests detected).

## Schema

`sharkcraft.area-explore/v1`.

## MCP

- `explore_area` — read-only. Input: `path` (required), `topFiles`
  (optional).

## Safety

- Read-only.
- No shell execution.
- Skips ignored dirs (`node_modules`, `.git`, `.sharkcraft`, `dist`,
  `build`, `.next`, `.turbo`, `.nx`, `coverage`, `.cache`).
- Walk is bounded at 4000 files per call.

## When to reach for it

- An agent (or human) is about to edit code in a dir it hasn't seen
  before.
- A reviewer wants the "shape" of a dir without opening 20 files.
- An onboarder is mapping a repo and wants per-dir context, not the
  repo-wide `shrk architecture map`.
