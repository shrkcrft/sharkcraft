# Healing plans

A healing plan turns a failure (stderr blob, log file, failed report,
or a failed command) into an **advisory** recovery plan.

> **CLI verb retired — MCP-only surface.** The former `shrk heal` CLI
> command (and the earlier `shrk heal from-*` subcommands) were removed.
> The deterministic healing-plan builder survives as the read-only MCP
> tool `create_healing_plan`. There is no CLI write path; the engine
> never auto-applies a healing plan.

## Surface

The MCP tool `create_healing_plan` builds the plan from exactly one of:

- `errorText` — a free-form error / stderr string.
- `filePath` — an error log on disk.
- `reportPath` — a failed JSON report.
- `command` + `exitCode` + `stderrText` — a failed command invocation.

The tool is read-only and returns the plan body only.

## Output

`sharkcraft.healing-plan/v1` — see `packages/inspector/src/healing-plan.ts`.

Key fields:

- `detectedDiagnostics` — reuses the diagnostics registry; same codes as
  the universal `shrk explain <stderr-blob>` (R48 folded diagnostics
  get/suggest into `shrk explain`).
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
the healing-plan builder (the `errorText` input recognises these
substrings):

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
