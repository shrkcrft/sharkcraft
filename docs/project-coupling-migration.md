# Project-coupling migration helper (R32)

Use `shrk migrate project-coupling …` when you have a SharkCraft fork
that embeds project-specific knowledge (paths, ids, names) directly in
the engine packages, and you want to externalise it into a pack +
config.

## Commands

```bash
shrk migrate project-coupling audit  --token <pat> [--token <pat> ...]
shrk migrate project-coupling plan   --token <pat> [--token <pat> ...]
shrk migrate project-coupling report --token <pat> [--token <pat> ...]
```

- `audit` — print findings to stdout (text by default; `--format
  markdown|json`; `--output <file>`).
- `plan` — group hits by externalisation target.
- `report` — write `.sharkcraft/reports/project-coupling-audit.{json,md}`.

The engine ships **zero built-in tokens**. You supply whatever
identifiers are project-specific in your workspace, e.g.:

```bash
shrk migrate project-coupling audit \
  --token <project-id> --token packages/<project> --token FEATURE_KEYS \
  --token primitive --token sandbox
```

## Output

Each hit includes:

- `file`, `line`, `column`
- The matched `token`
- A `snippet` of the line
- A recommended `externalizationTarget`:
  - `pack` — high-risk; move behind a pack contribution.
  - `local-config` — move to the workspace's `sharkcraft/`.
  - `profile` — fits an existing or new profile kind.
  - `fixture-only` — acceptable inside test fixtures.
  - `docs-example` — acceptable inside docs that use the project as an
    illustrative example.
- A `risk`: `low | medium | high`.
- An optional `nextCommand` hint.

The verdict is `clean` if no high-risk hits remain (fixtures and docs are
not counted as blockers).

## MCP

`get_project_coupling_report` — read-only — accepts `{ tokens[],
scanRoots[]?, excludeRoots[]? }`.

## Schemas

- `sharkcraft.project-coupling-audit/v1`
- `sharkcraft.project-coupling-plan/v1` (extraction plan)
