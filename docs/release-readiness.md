# Release readiness gate

`shrk release readiness` aggregates the read-only audits SharkCraft
already ships into one verdict: ready to tag, or blocked. It never
publishes and never writes.

```bash
shrk release readiness
shrk release readiness --strict
shrk release readiness --preflight .sharkcraft/reports/preflight.json
shrk release readiness --json
```

## What it checks

- `shrk doctor` — workspace + entry validation.
- Coverage score (warns < 80, fails < 50).
- Pack doctor with the release-check gate folded in (`shrk packs doctor --release`).
- Canonical docs present (`docs/overview.md`, `docs/philosophy.md`,
  `docs/safety-model.md`, `docs/testing.md`).
- README has Quick demo + Onboard sections.
- `package.json` carries `name`, `version`, `license`, `repository`.
- `examples/` directory present.
- Optional fold-in of a `release:preflight` summary JSON via `--preflight`.
- A static reminder that the MCP server has no write tools (the existing
  audit list test enforces this at runtime).

## Output shape

The JSON form is `sharkcraft.release-readiness/v1`:

```jsonc
{
  "schema": "sharkcraft.release-readiness/v1",
  "ready": true,
  "strict": false,
  "blockers": [],
  "warnings": [],
  "passed": [{ "id": "doctor", "status": "pass", "message": "…" }],
  "skipped": [],
  "checklist": [
    "shrk doctor → green",
    "shrk commands doctor → 0 errors / 0 warnings",
    "…"
  ]
}
```

## --strict

With `--strict`, every warning escalates to a blocker. The exit code is
non-zero whenever any blocker is present.

## --with-product-check (R20)

`shrk release readiness --with-product-check` also runs
`buildProductCoherenceReport(inspection, { strict })` and folds the result
into the readiness output. If the product check fails, readiness becomes
not-ready. See `docs/static-reports.md` and the CHANGELOG R20 entry for the
product-check rule set.

## MCP

`get_release_readiness` returns the same report shape; never writes.
