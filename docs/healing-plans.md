# Healing plans

`shrk heal` turns a failure (stderr blob, log file, failed report,
or a failed command) into an **advisory** recovery plan.

## Commands

R48 collapsed the four `shrk heal from-*` subcommands into a single
`--from <source>` flag:

```
shrk heal --from error:"<text>"
shrk heal --from file:<file>                         # an error log
shrk heal --from report:<report.json>                # a failed JSON report
shrk heal --from command:"<command>" --exit-code <n> --stderr-file <file>
```

Flags shared by all forms: `--format text|markdown|json`, `--output <file>`.

## Output

`sharkcraft.healing-plan/v1` — see `packages/inspector/src/healing-plan.ts`.

Key fields:

- `detectedDiagnostics` — reuses the diagnostics registry; same codes as
  `shrk explain <stderr-blob>` (R48 — diagnostics get/suggest folded
  into the universal `shrk explain`).
- `confidence` — `low | medium | high`.
- `likelyCauses`, `safeRecoverySteps`, `forbiddenQuickFixes`,
  `recommendedCommands`.
- `humanApprovalRequired`, `sourceWritesInvolved` — hard flags so callers
  know when *not* to proceed.
- `nextSafestCommand` — single best next step.

## Hard rules

- **Never auto-fixes**.
- **Never writes source**.
- **Never bypasses safety hooks** (`--no-verify` is always forbidden).
- **Never silences tests** to "recover".
- **Never commits secrets** to clear a signing failure.
- **Never deletes `.sharkcraft/sessions/` or `.sharkcraft/plans/`** to
  clear state.

## Polyglot diagnostics (R25)

R25 adds 10 polyglot diagnostic codes and matching keyword recognition in
`shrk heal --from error:...`:

| Code | Triggered by |
| --- | --- |
| `java-cannot-find-symbol` | `error: cannot find symbol` |
| `java-package-does-not-exist` | `package X does not exist` |
| `csharp-cs0246` | `CS0246` |
| `csharp-nu1101` | `NU1101` |
| `python-module-not-found` | `ModuleNotFoundError` / `No module named` |
| `python-pytest-collection-error` | `pytest` + `errors during collection` |
| `go-cannot-find-module` | `no required module provides package` / `cannot find module` |
| `go-import-cycle` | `import cycle` |
| `rust-e0432` | `E0432` / `unresolved import` |
| `rust-e0308` | `E0308` / `mismatched types` |

Each emits the failing language's canonical next command (e.g.
`go mod tidy`, `dotnet restore`, `cargo build`).

## MCP

`create_healing_plan` is read-only.
