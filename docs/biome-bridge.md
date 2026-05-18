# Biome bridge

Lighter than the ESLint bridge by design: Biome's lint grammar is
narrower and Biome does not yet ship a public custom-rule plugin
surface, so SharkCraft cannot produce native Biome rules.

## Surface (R45 + R47)

```bash
shrk biome scaffold                 # emit a biome.json that ignores generated paths
shrk biome config --preset auto     # alias of scaffold
shrk biome report --from boundaries.json   # convert boundary JSON to a Biome-adjacent shape
shrk biome explain-limitations             # what does NOT bridge
```

## `scaffold` (R45)

Emits a `biome.sharkcraft.json` with:

- `linter.rules.recommended: true`,
- `formatter.enabled: true`,
- `organizeImports.enabled: true`,
- `files.ignore: [...]` — populated from any SharkCraft path
  convention tagged `generated` / `build` / `dist` / `output`. Falls
  back to `["**/dist/**", "**/build/**"]` if no SharkCraft paths
  exist yet.

The scaffolded file documents in comments which SharkCraft rules
Biome **cannot** express. Dry-run by default; `--write` persists.

## `report` (R47, adjacent — not native)

Takes `shrk check boundaries --json` output and emits a JSON shape
roughly modelled on Biome's diagnostics:

```json
{
  "schema": "sharkcraft.biome-adjacent/v1",
  "tool": "sharkcraft",
  "generatedAt": "2026-05-16T...",
  "diagnostics": [
    {
      "category": "sharkcraft/boundary-violation",
      "severity": "error",
      "location": { "path": "/abs/file.ts", "line": 9, "column": 2 },
      "description": "cross-feature import (@x/a → @x/b)",
      "source": "sharkcraft"
    }
  ],
  "note": "Adjacent to Biome — not native Biome output. See `shrk biome explain-limitations`."
}
```

This is **adjacent**, not native: Biome does not consume this file
directly. Biome-result-aware tooling that already ingests
diagnostics-shaped JSON can use it.

If you want a universally-consumable shape, prefer
`shrk eslint report` (native ESLint result format) or
`shrk checks aggregate` (the v1 rollup).

## `explain-limitations` (R47)

| Biome can do | Biome cannot do |
|---|---|
| Generated path ignores | Cross-layer / cross-package boundary rules |
| Formatter / `organizeImports` defaults | Plan safety |
| | Pack signatures |
| | Knowledge stale-check |
| | Template drift |
| | Self-config doctor |
| | Custom SharkCraft rules with action hints |

Recommendation: use Biome for fast file-local linting / formatting;
keep `shrk doctor`, `shrk check boundaries`, `shrk safety audit` in
CI.

## Why not a Biome plugin?

Biome currently has no public extension API for custom lint rules.
This is documented upstream and may change; until it does, the bridge
strategy is the only path. R47's `biome report` is intentionally
labelled adjacent so consumers do not mistake it for a stable
contract — if Biome ever ships a native plugin surface, the bridge
can graduate.
