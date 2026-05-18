# Polyglot CI scaffold (R25)

`shrk ci scaffold github-actions --polyglot` appends per-language jobs to
the rendered workflow when the corresponding `ILanguageProfile` is
detected. No publish / deploy steps. Other CI providers emit a guidance
comment pointing at `shrk languages commands --format markdown`.

## Jobs

| Profile | Job(s) added |
| --- | --- |
| Java (Maven) | `mvn -B verify` |
| Java (Gradle) | `./gradlew test` |
| C# (.NET) | `dotnet restore && dotnet build --no-restore && dotnet test --no-build` |
| Python | `<install> && [lint] && [typecheck] && <test>` (driven by `shrk languages commands`) |
| Go | `go vet ./... && go test ./...` |
| Rust | `cargo fmt --check && cargo clippy -- -D warnings && cargo test` |

## Example

```bash
shrk ci scaffold github-actions --with-quality --polyglot --output .github/workflows/sharkcraft.yml --write
```

Resulting workflow contains a `sharkcraft` job (existing behaviour) and
one job per detected language (named `polyglot-<lang>`). All jobs run on
`ubuntu-latest`.

## Safety

- No publish / deploy steps anywhere in the generated YAML.
- All `setup-*` actions pinned to the published major version
  (`actions/setup-java@v4`, `actions/setup-dotnet@v4`,
  `actions/setup-python@v5`, `actions/setup-go@v5`,
  `dtolnay/rust-toolchain@stable`).
- Timeout of 20-25 minutes per language job.

## Limitations

- Polyglot YAML is only generated for GitHub Actions in R25. GitLab,
  Bitbucket, Azure, Jenkins users add jobs manually using
  `shrk languages commands --format markdown`.
- The polyglot section is *appended* to the existing scaffold body. If
  you want to interleave steps with the main SharkCraft job, edit the
  resulting YAML.
