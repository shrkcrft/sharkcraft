# @shrkcrft/compress

SharkCraft's deterministic context-compression engine.

Built to honour SharkCraft's hard rule — **no model inside the engine**. Every
transform is a pure function of its input: content routing, lossless
columnar/table compaction of homogeneous object arrays, log / search / diff /
line reduction, and reversible Compress-Cache-Retrieve (CCR).

Part of [SharkCraft](https://github.com/shrkcrft/sharkcraft) — a deterministic,
local-first toolkit that gives AI coding agents durable project context. See
[`docs/compression.md`](https://github.com/shrkcrft/sharkcraft/blob/main/docs/compression.md)
for the full guide, and the main repo for the `shrk` CLI and MCP server.

```ts
import { compressContent, InMemoryCcrStore } from '@shrkcrft/compress';

const store = new InMemoryCcrStore();
const result = compressContent(blob, { store, query: 'auth' });
// result.compressed · result.strategy · result.savings · result.ccrKey
```
