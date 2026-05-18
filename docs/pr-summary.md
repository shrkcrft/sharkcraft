# PR summary (R31 → R34)

Builds a deterministic PR description from changes + reports + (R34)
session/bundle artifacts.

## Commands

```bash
shrk pr summary [--since <ref>|--staged|--files a,b,c] [--max-items N] [--format markdown|json] [--output <file>] [--include-raw-links]
shrk pr description [...]    # alias

# R34 — derive changed-files from an existing artifact
shrk pr summary --from-session <id>
shrk pr summary --from-bundle <id>
```

`--from-session <id>` reads `appliedPlans[].changedFiles[]` from
`.sharkcraft/sessions/<id>/session.json`. `--from-bundle <id>` reads
`.sharkcraft/bundles/<id>/manifest.json`.

## Sections

1. Summary
2. Why _(edit me)_
3. What changed _(grouped by area)_
4. Safety
5. Validation
6. Risk / review notes
7. Breaking changes _(edit me)_
8. Migration notes _(edit me)_
9. Known limitations _(edit me)_
10. Follow-ups _(edit me)_
11. Commands run
12. Reports / artifacts

## MCP

- `get_pr_summary_preview` — read-only. Accepts the R34 session/bundle
  inputs.

## Schema

`sharkcraft.pr-summary/v1`.
