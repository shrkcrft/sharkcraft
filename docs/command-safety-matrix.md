# Command safety matrix

```bash
shrk commands matrix                    # markdown
shrk commands matrix --format json      # machine-readable
```

Each row describes one CLI command:

| Column | Meaning |
|---|---|
| `command` | Canonical `shrk ...` invocation |
| `category` | High-level bucket (core / analysis / quality / bundles / …) |
| `readsFiles` | Always `true` — every command reads project files |
| `writesDrafts` | Writes under `.sharkcraft/` only (never source code) |
| `writesSession` | Writes under a session/bundle subtree (never source code) |
| `writesSource` | Writes project source code — these are CLI-only writers |
| `runsShell` | Spawns a subprocess (e.g. `bun test`) |
| `mcpAvailable` | A corresponding read-only MCP tool exists |
| `requiresReview` | A human must review/approve before invoking |
| `safeForCi` | No source writes, no shell, no required review |
| `safeForMcp` | Read-only **and** exposed via the MCP server |

The matrix is derived deterministically from `COMMAND_CATALOG` — there is no
hand-maintained second source of truth. Update the catalog and the matrix
updates with it.

`shrk commands doctor` continues to check that every registered command has a
catalog entry (and vice versa).
