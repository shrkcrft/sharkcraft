# Architecture impact analysis

`shrk impact` estimates the architectural blast radius of a change before
it lands. Schema bumped to `sharkcraft.impact-analysis/v2` in R11; R12
added renderers, a dependency tree, and integration with the static
report site.

The canonical reference lives at **[docs/impact.md](impact.md)** — flag
listings, output shape, risk classification, renderers, and limitations.

## Quick recap

- Inputs: `<fileOrSpecifier>`, `--file`, `--specifier`, `--since`,
  `--staged`, `--files`, `--plan`, `--bundle`. Optional `--max-depth N`
  and `--limit N`.
- Output: `IImpactAnalysis` (v2) — schema `sharkcraft.impact-analysis/v2`.
  Adds direct + transitive dependents, dependency path examples,
  affected packages / templates / pipelines / presets / constructs,
  policy concerns, ownership, suggested test / verification / review
  commands, risk + risk reasons, truncations, diagnostics.
- Renderers (R12): `--format text|markdown|html|json`, `--output <file>`,
  `--tree` / `--no-tree`. Self-contained HTML with inline CSS, no JS.
- Report integration: `shrk report impact <impact.json>` and
  `shrk report site --impact <file>` / `--impact-dir <dir>`.

## MCP

`get_impact_analysis` returns the same payload, read-only.
