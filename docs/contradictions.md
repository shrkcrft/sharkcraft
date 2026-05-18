# Contradictions

`IContradictionReport` flags places where the repo's documentation drifts
from its code. Read-only; deterministic. Schema:
`sharkcraft.contradictions/v1`. Module:
`packages/inspector/src/contradictions.ts`.

## What it detects

| Kind | Trigger |
|---|---|
| `missing-path` | A doc references a path (e.g. `packages/foo/bar.ts`, `src/index.ts`, `tests/foo.rs`) that does not exist on disk. |
| `old-cli-path` | A doc uses the legacy `sharkcraft <verb>` form or a hard-coded `@shrkcrft/cli` invocation. The CLI was renamed to `shrk`. |
| `missing-command` | A doc's shell-fenced command runs a `shrk <verb>` not in the catalogue, or a `bun run <script>` not in `package.json`. |
| `deprecated-recommendation` | Doc recommends a tool that has been superseded (e.g. TSLint). |
| `doc-vs-config-conflict` | Reserved for future config-aware checks. |

## What it does NOT do

- It does not reformat docs.
- It does not patch them — output is read-only.
- It does not flag glob-style placeholders (`{x,y,z}`), HTTP URLs, schema
  identifiers (`sharkcraft.foo/v1`), or `<placeholder>` forms.

## CLI

```bash
shrk contradictions                       # text
shrk contradictions --format markdown
shrk contradictions --format html
shrk contradictions --format json
```

## MCP

`get_contradiction_report` — returns the structured report + a next-command
hint. Never writes.

## Integration points

- The ingestion pipeline embeds the contradiction report as the
  `contradictions` section of the repository knowledge model.
- `shrk validate-change` cross-references changed docs against the report to
  surface contradictions that the in-flight change would touch.
