# Template drift (R29)

`shrk templates drift` verifies every registered template against the
workspace and flags drift before it bites consumers.

## Commands

```
shrk templates drift [--template <id>] [--pack <packId>] [--var key=value ...] [--json]
shrk templates verify-paths [--template <id>]
shrk templates smoke
```

## What's checked

- **Forbidden legacy fragments** — per-template denylist of path
  fragments that must not appear. Example: `app.plugin-contract`
  must not emit anything under `contracts/<name>/`.
- **Missing barrels** — when a template emits an `export` op, the
  target barrel must exist (warning if not).
- **Missing anchors** — `insert-after` / `insert-before` ops must
  carry a non-empty anchor.
- **Unresolved related ids** — `template.related[]` must resolve to
  a knowledge entry or another template.
- **Path conventions** — sample paths SHOULD match a registered path
  convention. Mismatch surfaces as `info`, not `error` — convention
  coverage is a different concern.

## Output

`sharkcraft.template-drift/v1`. Per-template entry:

```json
{
  "templateId": "app.plugin-contract",
  "status": "pass | warn | fail",
  "samplePaths": ["libs/.../plugins/sample/index.ts"],
  "issues": [
    { "severity": "error", "code": "forbidden-legacy-path", "message": "..." }
  ]
}
```

Exit code is `1` when any template's status is `fail`.

## MCP

`get_template_drift_report({ templateId?, packId? })` returns the same
report over the read-only MCP surface.

## Decision

`sharkcraft/decisions/template-drift-checks-before-trust.md` describes
when packs and CI should run the check.

## R30 — Severity and CI controls

```
shrk templates drift --min-severity error|warning|info
shrk templates drift --hide path-no-convention[,<code>...]
shrk templates drift --strict          # promote warnings → errors at exit time
shrk templates drift --ci              # structured payload, exits non-zero on errors
shrk templates drift --format text|markdown|html|json
shrk templates drift --report          # writes .sharkcraft/reports/template-drift-<ts>.json
shrk templates drift --output <path>   # explicit path
```

Issue severities (`info`, `warning`, `error`) are intrinsic to the issue
code; filters operate on those severities. `--strict` promotes warnings
to errors for **exit-code purposes only** — the report payload is
unchanged so CI artifacts remain a faithful record.
