# GitHub Action quickstart

The shortest path from "I just installed SharkCraft" to "PRs are
gated on SharkCraft".

## One command

```bash
shrk ci scaffold github-actions --quickstart
```

That prints a dry-run preview. To persist:

```bash
shrk ci scaffold github-actions --quickstart --write
```

## What `--quickstart` enables

The quickstart turns on the gates that small repos can always run,
and detects whether the repo has the assets needed for the more
advanced gates. Decision table:

| Step | Always enabled | Conditional on |
|---|---|---|
| `shrk doctor` | ✓ |  |
| `check boundaries --changed-only` | ✓ |  |
| `self-config doctor` |  | `sharkcraft/sharkcraft.config.ts` exists |
| `knowledge stale-check` |  | `sharkcraft/knowledge.ts` exists |
| `templates drift` |  | `sharkcraft/templates.ts` exists |
| `packs signature-status` |  | `sharkcraft/packs.ts` exists |

Each step is wrapped with `|| true` so a missing advanced surface
**never** red-fails CI on a small repo.

## R47 dry-run output

```
=== CI scaffold (github-actions) — dry-run ===
  exact path         /<repo>/.github/workflows/sharkcraft.yml
  bytes              <n>
  next command       shrk ci scaffold github-actions --quickstart --write

# .github/workflows/sharkcraft.yml
name: SharkCraft
...

=== Explanation of gates ===
  shrk doctor                  detected   Validate sharkcraft/ config + knowledge / rules / templates registries.
  check boundaries --changed-only detected   Cross-layer / cross-package boundary enforcement (ESLint cannot express this).
  self-config doctor           detected   Repo-shape sanity (action hints, verification commands, rule wiring).
```

The "Explanation of gates" block (R47) labels every gate the workflow
will run, whether it was enabled by detection or by an explicit flag,
and what each gate protects.

## Other flags

| Flag | Effect |
|---|---|
| `--quickstart` | sensible-default bundle (above) |
| `--preset auto` | alias of `--quickstart` (semantically intended for "detection-driven") |
| `--with-pr-checks` | alias of `--quickstart` |
| `--changed-only` | force boundary check to `--changed-only` even outside quickstart |
| `--pr-comment` | also write a short summary comment on the PR |
| `--polyglot` | append per-language jobs (`shrk languages run`) |
| `--with-quality` / `--with-safety-audit` / ... | opt-in explicit gates |

## Permissions audit

`shrk ci permissions <workflow-file>` reports whether the workflow:

- posts PR comments,
- requests write permissions,
- uses tokens,
- pulls external actions / images.

`shrk ci permissions <workflow-file> --fix-preview` shows a least-
privilege diff.

## Reading the result

```bash
shrk ci report --reports-dir .sharkcraft/reports
```

Aggregates the JSON artifacts (`doctor.log`, `boundaries.json`,
`knowledge-stale.json`, `template-drift.json`, …) into a single
text / markdown / html / json view. Pair with
`shrk checks aggregate` (R47) if you also imported ESLint or Biome
findings via the universal protocol.

## What the quickstart does **not** do

- It does **not** sign anything. Plan signing is a deliberate
  developer action on the laptop, not in CI.
- It does **not** auto-fix. SharkCraft's `fix preview` writes only
  under `.sharkcraft/fixes/` and is never invoked from CI.
- It does **not** run any new MCP write tool. There are none. MCP
  remains read-only.
