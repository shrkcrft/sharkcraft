# Export bundles / sessions / quality / review

Local, shareable artifacts — no upload, no telemetry.

```bash
shrk export bundle <id> [--output <dir>]
shrk export session <id> [--output <dir>]
shrk export quality [--output <dir>]
shrk export review <packet.json> [--output <dir>]
```

The default output dir is `.sharkcraft/exports/<kind>-<id>`. Each export
contains a `summary.md` plus the relevant raw JSON / plan / report files.

The existing `shrk export <format>` (AGENTS.md / CLAUDE.md / .cursor/rules /
copilot-instructions) still works — the new subcommands are intercepted by
matching their format token (`bundle | session | quality | review`).
