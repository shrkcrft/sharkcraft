# Polyglot language support (R25)

SharkCraft started as a TypeScript / Bun toolkit. R25 adds first-class
support for **Java**, **C#**, **Python**, **Go**, and **Rust** alongside
the existing TypeScript / JavaScript flow. Detection is deterministic and
local — no compiler integration, no AST library, no model calls.

## `shrk languages`

```
shrk languages detect    [--format text|markdown|json] [--output <file>]
shrk languages commands  [--format text|markdown|json] [--output <file>]
shrk languages deps      [--language all|java|csharp|python|go|rust] [--format text|json]
shrk languages tests --files a,b,c [--format text|json]
```

- `detect` — walk the project, identify language profiles via manifest /
  build files (`pom.xml`, `build.gradle`, `*.csproj`, `pyproject.toml`,
  `go.mod`, `Cargo.toml`). Reports `confidence`, source / test roots,
  build tool, framework signals (Spring Boot, ASP.NET Core, FastAPI /
  Django / Flask, gin / echo, tokio / actix / axum, …), and the likely
  commands.
- `commands` — derive `install` / `test` / `typecheck` / `lint` / `build`
  per detected language (Maven / Gradle / dotnet / pip / poetry / uv,
  Go, Cargo).
- `deps` — scan imports / `using` / `import` / `use` directives. Distinguishes
  internal vs external dependencies via the package / namespace / module
  declarations found in the same file or build manifest.
- `tests` — predict the per-language test file(s) for a list of changed
  source files (`*Test.java`, `FooTests.cs`, `test_foo.py`, `foo_test.go`,
  `tests/foo.rs`).

## Schemas

| Surface | Schema |
| --- | --- |
| Profile | `sharkcraft.language-profile/v1` |
| Commands | `sharkcraft.language-command-set/v1` |
| Deps | `sharkcraft.polyglot-dependency-graph/v1` |
| Test impact | `sharkcraft.polyglot-test-impact/v1` |

## MCP

All polyglot MCP tools are **read-only**:

- `get_language_profiles`
- `get_language_commands`
- `get_polyglot_dependency_graph`
- `get_polyglot_test_impact`
- `get_language_report`

## CI

`shrk ci scaffold github-actions --polyglot` appends per-language jobs
(Maven / Gradle / dotnet / Python / Go / Rust) when the corresponding
profiles are detected. See `docs/polyglot-ci.md`.

## Boundaries

`shrk boundaries infer --language all` adds per-language *suggestion*
rules ("Java controllers should not import repositories directly",
"C# Domain must not depend on Infrastructure / Web", "Python domain must
not import a web framework", "Go pkg should not import cmd", "Rust crate
must not import the tests tree"). The boundary *engine* remains TS-aware.

## Presets

R25 ships 7 new built-in presets: `java-maven-service`,
`java-gradle-service`, `csharp-dotnet-service`, `python-service`,
`go-module`, `rust-crate`, `polyglot-monorepo`. See `shrk presets list`.

## Limitations

- Regex-only parsing. Conditional / runtime imports may be missed.
- C# `using X = Y;` alias usings are not categorised.
- Grouped Rust `use foo::{a, b};` records `foo` head only.
- Boundary engine itself is unchanged — suggestions are advisory.
- TypeScript / JavaScript detection is unchanged from R24; R25 just adds
  the new language module alongside.
