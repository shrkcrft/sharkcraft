# Token compression (`@shrkcrft/compress`)

SharkCraft compresses the text an agent reads — its own outputs and any blob
you hand it — so the same information costs fewer tokens. The engine is
`@shrkcrft/compress`: a deterministic, dependency-light layer built to honour
SharkCraft's hard rule — **no model inside the engine**. Every transform here
is a pure function of its input. Same bytes in, same bytes out, on every
machine.

## Why

The biggest cost an AI agent pays for SharkCraft is the tokens in the payloads
it reads: knowledge graphs (hundreds of homogeneous node/edge objects),
task packets, MCP tool responses, and the tool outputs the agent itself
collects (logs, grep results, diffs). Most of that is structural redundancy —
repeated JSON keys, pretty-print indentation, near-duplicate log lines.
Compression removes the redundancy without removing the meaning.

## The three levers

### 1. Lossless structural compaction (always on, zero risk)

- **Minified MCP responses.** Every MCP tool response is serialized as
  minified — but still valid — JSON. The shape is unchanged (JSON-parsing
  clients keep working); only the pretty-print indentation every
  `JSON.stringify(data, null, 2)` used to pay for is gone. Set
  `SHRK_MCP_PRETTY=1` to restore indentation for debugging.
- **Columnar tables.** A homogeneous array of objects (graph nodes, rules,
  paths, …) collapses to a *columnar* form: the shared schema is hoisted once
  and each row carries only values. `get_knowledge_graph` exposes this via
  `format:"table"` — still valid JSON, a fraction of the tokens. An `absent`
  list records `[row, col]` positions whose key was missing, so the original
  array reconstructs **exactly** (`expandColumnar`).
- **Value dictionaries.** On top of columnar, a *low-cardinality* column (the
  graph's `kind`/`relation`/`source`, a list's `type`/`priority`) is value-
  dictionary encoded: its distinct values are written once into `_table.dict[col]`
  and each row holds a small integer index instead of repeating the value. A cell
  is an index *iff* its column is a key of `dict` (decided structurally, never by
  the value), so it round-trips exactly. It's triple net-loss-guarded (per-column
  + table-level byte checks + the wire net-loss guard), so it ships only when it
  shrinks the payload — `dict` is omitted entirely otherwise.

All are lossless: nothing is dropped, so nothing needs recovering.

### 2. Lossy line reduction (opt-in, reversible)

For logs, search output, and diffs — the high-volume, low-density blobs an
agent collects — the compressor keeps the signal and elides the noise:

| Content      | Kept                                                            |
|--------------|----------------------------------------------------------------|
| Build log    | errors (+1 line of context), de-duped warnings, summary lines, first/last anchors |
| Search (grep)| the first match per file (no file vanishes) + top matches by query overlap / priority keywords |
| Unified diff | changed lines + a tight context window; hunks capped per file (first + last + highest-scoring) |
| Source code  | imports, type/interface/enum declarations + their members, and function/method **signatures**; function **bodies** are elided (an "outline") |
| Markdown     | every header, each section/paragraph **lead** line, table rows, a capped run of list items; paragraph continuations and fenced-code bodies are thinned |
| Plain text   | exact-duplicate lines dropped, blank runs collapsed            |

**Code outline.** Source code routes through a parser-free outliner: a
comment/string-aware brace scanner tags each block as a function/control body
or a declaration, then drops lines inside function bodies while keeping the
file's shape (imports, types, class/interface/enum members, signatures). It
never rewrites code — only selects which lines to show — and the original is
always recoverable via CCR, so an approximate scan costs a few extra/fewer
kept lines, never corruption. Typical reduction: 40–60% on real files.

Each dropped run becomes a `… N lines omitted …` marker. These passes are
**lossy but reversible** — see CCR below.

### 3. CCR — Compress-Cache-Retrieve (reversibility)

When a lossy pass drops detail, the original is cached under a deterministic
content key and a marker is appended:

```
<<ccr:000c7a52d842e7d2 full log: 42 lines>>
```

The agent retrieves the full text on demand:

- MCP: `retrieve_original { "key": "000c7a52d842e7d2" }` (reads an in-memory
  store that lives for the server session — the MCP server never writes to
  disk, honouring the read-only contract).
- CLI: `shrk expand 000c7a52d842e7d2` (reads `.sharkcraft/ccr/`, written by
  `shrk compress`).

Lossless passes (tables, minified JSON) never emit a marker — there is nothing
to retrieve.

The CLI file store is content-addressed and cross-process. `TtlFileCcrStore`
adds an optional **TTL + size eviction** (entries older than `ttlMs`, or past
`maxEntries`, are swept) for a bounded on-disk cache; the MCP store stays
in-memory and unbounded-per-session to honour the read-only contract.

## Surfaces

### CLI

```bash
shrk compress <file>                 # compress a file; compressed text → stdout
cat build.log | shrk compress --stdin --type build-log
shrk compress data.json --json       # full result + token accounting as JSON
shrk compress big.diff --query auth  # bias what's kept toward "auth"
shrk compress doc.md --lossless      # refuse to drop lines (passthrough if it would)
shrk compress x.json --no-cache      # don't write a CCR original
shrk expand <ccr-key>                # retrieve a cached original

# Compress ANY command's output in one step (no temp-file detour):
shrk knowledge list --json --compress
shrk task "add an auth rule" --compress --compress-query auth
```

`shrk compress` prints the compressed blob to stdout (pipeable) and a one-line
savings summary to stderr (`table: ~40 → ~19 tokens (−53%, est.)`). With `--json`
it prints the full structured result instead.

**Global `--compress` / `--ccr` flag.** Append `--compress` (alias `--ccr`) to
*any* read command and shrk re-runs it, compresses its stdout, and caches the
original for `shrk expand` — so you never need the `cmd > tmp; shrk compress tmp`
two-step. `--compress-type <t>` forces a content type and `--compress-query <q>`
biases what's kept. It's opt-in (a run without the flag is byte-identical) and
robust to commands that hard-exit (the command runs in a child process, so its
real exit code is preserved).

**`--lossless`.** Refuses any reduction that drops lines/rows/hunks: a pass that
would elide returns the input untouched instead, while provably-lossless
transforms (JSON→columnar) still apply. Use it when you need output that is fully
reconstructable from itself, without relying on the CCR cache.

**`--query` / `--max`.** `--query` re-orders which matches/hunks survive (real
BM25 relevance) and `--max` caps how many are kept. Note: by default the
per-file budget auto-sizes and keeps everything until a blob exceeds it, so
`--query` has no *visible* effect (same output, same `savedRatio`) until `--max`
or a large input forces drops — and `ccrKey` is a hash of the **original**, so it
never changes with these flags. The `--json` payload reports `queryApplied` so
the query's effect is observable even when the ratio is unchanged.

**Token counts are estimates.** `tokensBefore`/`tokensAfter`/`savedRatio` come
from a deterministic chars-per-type heuristic, **not** a BPE tokenizer; the
`--json` payload carries `tokensAreEstimated: true` and the stderr summary is
suffixed `est.`. Treat `savedRatio` as approximate (accurate on percentages,
rough on absolutes).

**`--json` net-loss guard.** On a passthrough / no-win blob the envelope sets
`"passthrough": true` and reports `inputBytes` instead of echoing the full
content back in `compressed` — so compressing a tiny blob never costs more tokens
than the input. On a real win the full `compressed` field is present as before.

**CCR cache is bounded.** Originals live under `.sharkcraft/ccr/` and the store
evicts the oldest past a fixed cap (count-based, so a key never silently expires
out from under `shrk expand`). Lossy elision markers (`… N lines omitted`) are
annotated with the recovery key — `… N lines omitted (shrk expand <key>)` — so a
clipped view still advertises that the detail is retrievable.

**`--json` is minified by default.** Every CLI command's `--json` output is
emitted as the smallest valid JSON (no indentation) — it's for machine / agent
consumption, mirroring the MCP wire. The shape is unchanged (only whitespace is
removed), so `JSON.parse` consumers are unaffected. Set `SHRK_JSON_PRETTY=1` for
human-readable 2-space indentation.

### MCP (read-only)

- `compress_context { content, contentType?, query?, maxItems?, maxTokens? }` —
  compress a blob before feeding it back to the model. Returns the compressed
  text, the strategy, token accounting, and a `ccrKey` when a lossy pass cached
  the original. `contentType:"source-code"` runs the code outliner
  (`compressCode`); `maxTokens` arms the lossy SmartCrusher row-sampler for
  oversized homogeneous arrays (see below).
- `retrieve_original { key }` — the reverse of compression.
- `get_knowledge_graph { format: "table", maxTokens? }` — the largest payload,
  columnar. With `maxTokens`, a node/edge list still over budget falls back to
  the lossy SmartCrusher sample (original CCR-cached, retrieve via the returned
  `ccrKey`). `deps_audit { maxTokens }` budgets its per-package report list the
  same way.
- `list_knowledge` / `list_rules` / `list_path_conventions` / `list_templates` / `list_pipelines` / `list_presets` / `list_packs` / `list_boundary_rules` `{ format: "table" }` — the registry lists, columnar (still valid JSON, schema hoisted once; nested-object cells preserved losslessly).
- `get_graph_impact` / `get_graph_callers` / `get_graph_context` / `get_graph_search` / `get_graph_cycles` / `get_graph_impact_analysis` / `get_code_intelligence_state` / `get_architecture_map` `{ format: "table" }` — node/check/analysis arrays columnar-encoded in place (scalars and small/heterogeneous arrays are left untouched).
- `compress_context` with `maxTokens` (library `compressContent({ maxTokens })`) — for a homogeneous array too large even after lossless columnar compaction, falls back to a **lossy statistical sample** (SmartCrusher): front/back anchors, numeric outliers, query matches, and one row per dedup-class are kept; the rest is dropped and the original CCR-cached. Deterministic, never a net loss.
- `align_cache` / `restore_cache` — reversible volatile-token placeholdering for KV-cache prefix stability (see Cache alignment below).
- `get_relevant_context` / `create_agent_brief` `{ compact: true }` — run shrk's OWN markdown body through the markdown compressor (reversible via the server CCR store + `retrieve_original`). Opt-in, so the brief/context seed is never silently thinned.
- `get_task_packet` / `smart_context_bundle` `{ format: "table" }` — the structured object-array fields (relevant rules/paths/templates, preset recommendations, ranked files, doc hits, verification commands) columnar-encoded; scalars and the markdown context body are left untouched.
- `deps_audit` / `search_all` / `search_knowledge` / `get_command_catalog` / `code_find_usages` / `get_graph_unresolved` `{ format: "table" }` — the remaining homogeneous-array tools (per-package dependency reports, ranked search hits, the command catalog, symbol usages, unresolved-import files) columnar-encoded in place.

**Table is the default.** Every columnar-capable tool emits `table` by default,
so agents get the savings without asking. Set `SHRK_MCP_TABLE=0` (or
`false`/`no`/`off`) on the server to opt out fleet-wide and restore the explicit
array shape for clients that need it. `format:"json"` always forces the explicit
array per call; `format:"table"` always forces columnar — both override the
default. Compaction stays conservative: small / heterogeneous arrays are left as
bare arrays (`compactArrayToColumnar` returns null), so default-on only reshapes
payloads where columnar is an actual token win.

### Dashboard

The read-only dashboard surfaces a **Token Savings** page (`#/compression`,
backed by the `GET /api/compression` endpoint) that measures the compression
layer on the live workspace: per-surface before/after token counts and the
total reduction. The measurement applies the same net-loss guard as the engine
— a surface never reports a negative saving, because the engine ships whichever
encoding is smaller. The response carries a `tokensAreEstimated` flag and the
page labels counts accordingly (the estimator is accurate on percentages but
rough on absolutes; an exact BPE tokenizer, when present, flips it to exact).
See `docs/dashboard.md`.

### Cache alignment

`detectVolatileTokens(text)` flags tokens that destabilise a provider's KV-cache
prefix — UUIDs, JWTs, ISO-8601 timestamps, hex hashes, epoch millis. The active
form, `alignVolatileTokens(text, priorMap?)`, replaces each with a stable,
self-describing placeholder (`«vk:uuid:0001»`) and returns a reversible map;
`restoreVolatileTokens(aligned, map)` inverts it exactly. Carrying the map
across turns keeps a value's placeholder stable, which holds the cache prefix
steady. Surfaced as `shrk align` / `shrk unalign` (CLI) and `align_cache` /
`restore_cache` (MCP, read-only — the map travels in the payload, never to
disk). Deterministic; lossless-via-restore.

### Token estimate

`estimateTokens(text, contentType?)` reports tokens. With a content type it uses
a class-specific chars/token ratio (punctuation-dense JSON ≈ 2.5, code ≈ 3.2,
prose ≈ 4) for a more accurate count; with none it reproduces the legacy
`chars/4` formula exactly, staying in lockstep with `@shrkcrft/context`.

### Note on duplicate JSON keys

`compressJson` parses with `JSON.parse`, which follows standard last-wins
semantics for a (malformed) object with duplicate keys — the duplicate is
dropped before compaction. This is JSON-value-faithful, not byte-faithful; it is
not flagged lossy.

### Library

```ts
import { compressContent, InMemoryCcrStore } from '@shrkcrft/compress';

const store = new InMemoryCcrStore();
const result = compressContent(blob, { store, query: 'auth' });
// result.compressed, result.strategy, result.savings, result.ccrKey
```

## Advanced reductions

These build on the three levers for specific high-volume shapes. Each is
deterministic and lossless or CCR-reversible.

- **Diff-noise offload.** A unified diff segments by `diff --git`; a lockfile
  section (`package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, …) collapses
  to a one-line `[lockfile <name>: N lines elided <<ccr:…>>]` marker, and a
  whitespace-only hunk (pure reindentation) collapses likewise. A code diff with
  no such noise is byte-identical to before. Big wins on PR/CI diffs.
- **Log-template mining (lossless).** Repetitive *kept* log runs
  (`worker-3 processing batch 17 ok` × N) collapse to one template plus a compact
  per-column encoding (`seq` for counters, `cyc` for cycles, `lit` otherwise) —
  reconstructable exactly, no CCR needed. Only runs the selector keeps are mined
  (droppable noise still elides to one line), so noisy logs never get larger.
  Each dropped run's `… N omitted …` marker carries the CCR key inline.
- **Object-map columnar.** An object *keyed by id* with homogeneous values
  (`{ n1:{kind,score}, n2:{…} }`) hoists its shared schema into an `_omap`
  envelope — the array columnar's analogue for the map shape — reconstructable
  via `expandObjectMap`.
- **Adaptive sizing.** When the lossy sampler has no explicit cap, it sizes the
  keep-set from the data's information curve (unique-bigram knee, cross-checked
  with simhash near-dup collapse and a zlib redundancy bound) — fewer rows on
  redundant data, more on diverse — instead of a flat K.
- **BM25 relevance.** Query-biased fetches rank kept rows/lines by BM25
  (idf-weighted, length-normalized, with an exact-match boost for ID-shaped
  terms) rather than bare token overlap. With no query, behaviour is unchanged.

## Read-accuracy table encodings

The default table shape is columnar JSON. `columnarToCsv` / `columnarToMarkdownKv`
offer the same data as CSV or Markdown key/value blocks for model read-accuracy,
each reversible (`csvToObjects` / `markdownKvToObjects`). The columnar default
stands pending the comprehension eval (`scripts/compress-comprehension-eval.ts`),
which scores extraction accuracy + response tokens per format against a local
model; its wire-token half always runs and shows columnar as the token win.

## Content routing

`detectContentType` classifies a blob (JSON array / JSON / git diff / search
results / build log / source code / markdown / **YAML** / **CSV-TSV** / plain
text) by ordered heuristics; `compressContent` dispatches to the matching
compressor. Compiler diagnostics (`src/a.ts(10,5): error`) route to search
output, not source. A blob that doesn't match one clean type but *mixes* types
(prose + a JSON block + a stack trace) is **segmented** and each run compressed
with its own strategy (`segmentContent`). Force a class with `contentType` /
`--type` when you already know it.

## Guarantees

- **Deterministic.** No randomness, no clock, no model. The same input and
  options always produce the same output and the same CCR key.
- **Never a net loss.** Every compressor measures itself (`measureSavings`)
  and falls back to passthrough if the "compressed" form isn't actually
  smaller.
- **Reversible where lossy.** Anything dropped is recoverable via CCR.
- **MCP stays read-only.** The MCP CCR store is in-memory; only the CLI writes
  cache files (under `.sharkcraft/ccr/`).

See also: [`docs/overview.md`](overview.md), [`docs/architecture.md`](architecture.md).
