# Import graph analysis

```bash
shrk graph imports
shrk graph imports --cycles
shrk graph imports --fan-in
shrk graph imports --fan-out
shrk graph imports --orphans
shrk graph imports --json
```

Adds workspace-package detection, cycle detection (Tarjan SCC), fan-in / fan-out
ranking, orphan file detection, and unused-public-entrypoint heuristic on top
of the existing `summarizeImports` summary.

## MCP

`get_import_graph_analysis` exposes the same payload.
