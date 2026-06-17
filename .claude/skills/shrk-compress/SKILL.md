---
name: shrk-compress
description: Cut the tokens you read. Use shrk's deterministic compression — compress any blob (logs/search/diff/JSON/code/markdown) before re-feeding it to the model, ask large MCP tools for the columnar `format:"table"`, and recover dropped detail on demand. No model in the loop; everything is reversible.
---

# shrk-compress — read the same information for fewer tokens

SharkCraft ships a deterministic compression engine (`@shrkcrft/compress`). It
has **no model inside** — every transform is a pure function of its input, and
anything lossy is recoverable. Reach for it whenever a payload is large.

## When to use it

- You ran a tool (grep, build, test, `git diff`, a big JSON dump) and are about
  to paste the output back into the conversation → **compress it first**.
- You're calling a shrk MCP tool that returns a big list or graph → **ask for
  the columnar form**.
- You want a file's shape without its bodies → **let it outline the code**.
- You re-send the same volatile-token-laden context each turn and want cache
  hits → **align it**.

## How (MCP, read-only)

- `compress_context { content, query?, contentType?, maxItems? }` — routes the
  blob by type (JSON→columnar table, log/search/diff→signal lines, code→outline,
  markdown→skeleton) and returns `{ compressed, strategy, tokensBefore,
  tokensAfter, ccrKey? }`. If a lossy pass dropped detail it emits a
  `<<ccr:KEY>>` marker and a `ccrKey`.
- `retrieve_original { key }` — get the full original back for a `ccrKey`.
- Pass `format:"table"` to the big read tools — `get_knowledge_graph`,
  `list_knowledge` / `list_rules` / `list_path_conventions` / `list_templates` /
  `list_pipelines` / `list_presets` / `list_packs` / `list_boundary_rules`,
  `get_graph_impact` / `callers` / `context` / `search` / `impact_analysis`,
  `get_code_intelligence_state`, `get_architecture_map`. You get the same data
  as a columnar `{ _table: { cols, rows, absent } }` (still valid JSON, schema
  hoisted once). Reconstruct objects by zipping `cols` with each row, skipping
  `absent` `[row,col]` positions.
- `align_cache { content, map? }` / `restore_cache { content, map }` — swap
  volatile tokens (UUIDs/JWTs/timestamps/hashes) for stable `«vk:…»`
  placeholders to keep a KV-cache prefix steady across turns; carry the returned
  `map` forward. Reversible.

## How (CLI)

```bash
shrk compress <file>          # compressed text → stdout, savings → stderr
cat build.log | shrk compress --stdin --query "connection refused"
shrk compress data.json --json     # full result + token accounting
shrk expand <ccr-key>         # recover a cached original
shrk align <file> --map m.json     # placeholder-align; shrk unalign restores
```

## What you can rely on

- **Deterministic** — same bytes in, same bytes out.
- **Lossless where it can be** — JSON → columnar table is exactly
  reconstructable; minified MCP responses keep their shape.
- **Reversible where it can't** — every lossy pass caches the original (CCR) and
  measures itself; a pass that wouldn't shrink the payload passes it through
  unchanged, so compression is never a net loss.
- **For huge arrays**, pass `maxTokens` (library) to opt into statistical row
  sampling (anchors + outliers + query matches kept; the rest CCR-cached).

See `docs/compression.md` for the full reference.
