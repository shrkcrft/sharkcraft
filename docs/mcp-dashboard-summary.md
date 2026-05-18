# MCP dashboard summary

`get_dashboard_summary` is the one-call read-only MCP tool agents use to
get a compact picture of the workspace.

```jsonc
{
  "schema": "sharkcraft.dashboard-summary/v2",
  "generatedAt": "...",
  "quality": { "score": 87, "overall": "ok", "blockers": 0, "warnings": 3 },
  "safety": {
    "mcpAnyWritable": false,
    "writesSource": 4,
    "writesDrafts": 12,
    "writesSession": 10,
    "runsShell": 2,
    "readOnly": 100
  },
  "readiness": { "score": 71, "grade": "good" },
  "coverage": { "overall": 65, "categories": 9 },
  "drift": { "error": 0, "warning": 4, "info": 1 },
  "areas": 24,
  "bundles": 2,
  "sessions": 6,
  "constructs": 7,
  "playbooks": 1,
  "packs": { "total": 1, "invalid": 0 },
  "policy": { "registrations": 3, "checks": 4, "passed": false },
  "mcpTools": { "total": 116, "anyWritable": false },
  "reportSite": { "available": false, "dir": "..." },
  "nextCommands": ["shrk quality", "shrk report site"]
}
```

Optional inputs:

| Field | Effect |
|---|---|
| `includeRecentSessions` | Add a `recentSessions[]` array (id / phase / nextAction). |
| `includeRecentBundles`  | Add a `recentBundles[]` array (id / status / risk). |
| `maxItems`              | Cap each list (default 5). |

The tool never writes anything and never executes shell commands.
