# `baselines/`

Committed artifacts pinned by `baselines[]` in `sharkcraft/sharkcraft.config.ts`
and checked by [`shrk baseline check`](../docs/baseline-drift.md).

**Do not hand-edit these files.** They are recomputed, not authored:

```bash
shrk baseline check                 # does the current value still match?
shrk baseline diff                  # what moved (no verdict)
shrk baseline update --id <id>      # bless an intentional change
```

Drift is **two-way** — an entry silently *lost* fails exactly like one gained,
which is the failure mode a hand-rolled drift script usually misses.

| File | Pins | Why it matters |
|---|---|---|
| `mcp-tools.json` | every tool registered in `ALL_TOOLS` | the public MCP surface; a tool dropped from the wire is invisible to every agent while the build stays green |
