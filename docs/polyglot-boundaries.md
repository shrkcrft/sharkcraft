# Polyglot boundary enforcement (R27)

SharkCraft's boundary engine remains TypeScript-aware. R27 layers a parallel
**polyglot boundary report** on top that evaluates conservative built-in
rules against the polyglot dependency scan (regex-based, no AST).

## Built-in rules

| Language | Rule id | Severity | Catches |
|---|---|---|---|
| Java | `java.domain.no-spring-web` | error | `**/domain/**` importing `org.springframework.web.*` |
| Java | `java.controller.no-repository-direct` | warning | `**/controller/**` importing `*.repository.*` / `*.dao.*` |
| Java | `java.main.no-test-import` | error | `src/main/java/**` importing `test`/`tests`/`junit`/`testng` |
| C# | `csharp.domain.no-aspnet` | error | `**/Domain/**` importing `Microsoft.AspNetCore.*` |
| C# | `csharp.web.no-infrastructure-direct` | warning | `**/Web/**` importing `*.Infrastructure.*` |
| C# | `csharp.main.no-test-import` | error | `.cs` files importing `*.Tests.*` |
| Python | `python.domain.no-web-framework` | error | `**/domain/**` importing `fastapi`/`django`/`flask`/`starlette` |
| Python | `python.app.no-tests-import` | error | `src/` or `app/` importing `tests.*`/`test_*` |
| Python | `python.no-cross-layer-parent-relative` | warning | `from ...x` (3+ parent levels) |
| Go | `go.pkg.no-cmd-import` | error | `pkg/` importing `cmd/` |
| Go | `go.internal.visibility` | error | any file importing `**/internal/**` |
| Go | `go.no-import-cycle-hint` | warning | placeholder for cycle reports |
| Rust | `rust.lib.no-tests-import` | error | `src/` importing `tests::` |
| Rust | `rust.no-test-only-module-import` | warning | importing `crate::test*` from non-test code |
| Rust | `rust.no-super-cross-crate-hint` | warning | `super::super::super::` chains |

## CLI

```bash
shrk boundaries enforce                  # all detected polyglot languages
shrk boundaries enforce --language java
shrk languages boundaries --format markdown
shrk check boundaries --polyglot         # combined TS + polyglot view
```

Exit code is non-zero iff there is at least one **error** severity violation.

## MCP

`get_polyglot_boundary_report` is read-only. It returns the same shape as
the CLI report and never persists.

## Schema

`sharkcraft.polyglot-boundary-report/v1`. Fields: `languages`, `rules[]`,
`edges[]`, `violations[]`, `counts`, `limitations`, `suggestedFixes`.

## Limitations

- Regex-based scan; false positives/negatives are possible.
- Built-in rules cover conservative defaults — extend via project-local
  TypeScript boundary rules when you need stricter enforcement.
- The polyglot engine does not enforce TS-side rules; use `shrk check
  boundaries` for that. `--polyglot` runs both.
