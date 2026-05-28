# Code intelligence layer (design — R62)

> **Status: shipped (Wave 1 — R63–R65); the design described here is
> live as `@shrkcrft/graph`.** Subsequent waves (rule-graph,
> structural-search, impact-engine, context-planner,
> architecture-guard) shipped through R83. See
> [`roadmap-code-intelligence.md`](roadmap-code-intelligence.md) for
> the per-wave status table.
>
> Two clarifications vs the original design:
>
> 1. **Layer order:** `@shrkcrft/graph` sits **above**
>    `@shrkcrft/inspector` (not below as originally drawn). The
>    extractor re-uses `buildSymbolIndex` from inspector; placing
>    graph above keeps SharkCraft's "lower-cannot-import-higher" rule
>    intact.
> 2. **JSONL writes wipe per-kind files** on every snapshot rewrite.
>    This is the simplest correctness guarantee — kinds that become
>    empty after a delete don't survive across writes.

## 1. Why this exists

SharkCraft already gives an AI agent *a lot* about a repo's **structure**
(rules, templates, pipelines, presets, boundaries, packs, ownership).
What it does **not** yet give the agent is a fast, durable, queryable
map of the **code itself** — files, symbols, who-imports-whom, who-uses-
what — at a granularity below the per-command on-demand scans we have
today.

Today's primitives are real but ephemeral:

| Concern | Where it lives | Shape |
|---|---|---|
| File-level imports | `packages/boundaries/src/scan/scan-imports.ts` | Regex scan, on-demand, no path-alias resolution |
| Per-file symbols (exports/locals/re-exports) | `packages/inspector/src/symbol-index.ts` | TS AST, per-file, no cross-file index |
| Project-wide symbol search | `findSymbolInProject` in same file | Full-tree walk + per-file AST, on-demand |
| Fan-in / fan-out / cycles / orphans | `packages/inspector/src/import-graph-analysis.ts` | On-demand, file-level only |
| File-level impact | `packages/inspector/src/impact-graph.ts` + `shrk impact` | On-demand, rebuilt every call |
| Asset graph (rules, templates, …) | `packages/inspector/src/knowledge-graph.ts` + `shrk graph` | Persistent registry, no code nodes |

Every code-level question today re-walks the file tree and re-parses
files. That's fine for one call. It's expensive when an agent makes
ten. And none of it understands **symbols** beyond a single file — the
agent can ask "is `IFoo` exported from this file?" but not "who *uses*
`IFoo` across the repo?", which is exactly the question that drives
impact and context decisions.

The code intelligence layer fills that gap with **one persistent,
incrementally-updated graph** that unifies:

1. **Code nodes** — files, symbols (exports, locals, re-exports),
   packages.
2. **Code edges** — file-imports-file, file-declares-symbol,
   symbol-references-symbol, package-depends-on-package.
3. **Bridges to the existing asset graph** — file-belongs-to-template,
   file-violates-boundary, file-implements-construct.

The result is a single graph the agent can query for: "which files are
relevant to *X*?", "what depends on this symbol?", and "what does
changing this file break?" — without the agent having to stitch
together five separate tool calls.

## 2. Scope

### In MVP

- TypeScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) source files.
- Files, exports, locals, re-exports.
- File-to-file import edges, with **tsconfig path-alias resolution** so
  `@shrkcrft/foo` resolves to a workspace file.
- Workspace packages (from `package.json` workspaces + Nx project
  graph).
- Cycles (SCC), fan-in / fan-out, orphans, unused public entrypoints —
  refactored to read from the index instead of re-scanning.
- Affected files for a set of changed files (closure of importers).
- Boundary-rule violations, surfaced as edges with `violates: <ruleId>`.
- Persistent on-disk store under `.sharkcraft/graph/`.
- Incremental updates by mtime + content hash.
- CLI: `shrk graph index | status | search | context | impact`.
- MCP: read-only equivalents.
- Bridge to the existing knowledge graph so a single query can return
  both "code that touches X" and "rules that apply to X".

### Out of MVP (deferred)

- Symbol-level *call* edges (who calls function `foo`). MVP records
  *declarations* and *re-exports*; references and call edges land in
  Phase 2.
- Other languages (Java, C#, Python, Go, Rust). The schema is
  language-neutral; only the TS extractor ships in MVP.
- Type-checker-level resolution (we never instantiate a full
  `ts.Program` — see §7).
- Plugins / contracts / capabilities / policies / adapters / generated
  files / quality gates — deferred to Phase 3 once the file/symbol
  layer is solid.
- Live file watcher / daemon. Indexing is invoked explicitly (CLI or
  pre-hook); no background process.
- Cross-repo or multi-repo graphs.

## 3. Architecture overview

```
                  ┌────────────────────────────────────────────┐
                  │           shrk graph <verb>  (CLI)         │
                  └────────────┬───────────────────────────────┘
                               │
                               ▼
                  ┌────────────────────────────────────────────┐
                  │  @shrkcrft/code-graph  (new package)     │
                  │                                            │
                  │  • IndexBuilder   • IncrementalUpdater     │
                  │  • GraphStore     • Query API              │
                  │  • Resolvers (alias, Nx, workspace)        │
                  └────┬────────────────┬──────────────────────┘
                       │                │
                       ▼                ▼
        ┌──────────────────────┐   ┌──────────────────────┐
        │ TS AST extractor     │   │ Existing primitives  │
        │ (re-uses             │   │ wrapped, not         │
        │  buildSymbolIndex,   │   │ duplicated:          │
        │  scanImports)        │   │  – knowledge-graph   │
        │                      │   │  – boundaries        │
        │                      │   │  – impact-graph      │
        └──────────────────────┘   └──────────────────────┘
                       │                │
                       └────────┬───────┘
                                ▼
                  ┌────────────────────────────────────────────┐
                  │ .sharkcraft/graph/                         │
                  │   meta.json      manifest, schema version  │
                  │   nodes/*.jsonl  one file per node-kind    │
                  │   edges/*.jsonl  one file per edge-kind    │
                  │   files.json     file → fingerprint        │
                  │   symbols.idx    name → [nodeId, …]        │
                  └────────────────────────────────────────────┘
```

Key design choices:

- **One package** (`@shrkcrft/code-graph`) sits at the inspector layer
  (above `boundaries` / `workspace` / `config`, below `mcp-server` /
  `cli`). It re-exports a stable query API.
- **No new compiler frontend.** We re-use `buildSymbolIndex` and
  `scanImports`. The new code is about *persistence*, *resolution*, and
  *graph-shaped queries*.
- **JSONL-per-kind on disk.** Append-friendly during reindex, easy to
  diff in git, easy to switch to SQLite later without touching callers.
- **Read-only MCP, write-capable CLI.** Per the SharkCraft safety
  contract, MCP never writes the index; only the CLI does.

## 4. Package and module structure

A single new package keeps the surface small:

```
packages/code-graph/
  src/
    index.ts                 # public API re-exports
    schema/
      node-kinds.ts          # enum NodeKind
      edge-kinds.ts          # enum EdgeKind
      types.ts               # INode, IEdge, IGraphFingerprint, …
      schema-version.ts      # SCHEMA = 'sharkcraft.code-graph/v1'
    store/
      graph-store.ts         # load / save / append; JSONL-backed
      file-fingerprint.ts    # mtime + sha1 content hash
      manifest.ts            # meta.json shape
    indexer/
      index-builder.ts       # full rebuild
      incremental-updater.ts # delta apply
      extract-ts-file.ts     # per-file TS extractor (uses symbol-index)
      detect-workspace.ts    # workspace pkg + Nx integration
      resolve-imports.ts     # path-alias + workspace + node-modules
    query/
      query-api.ts           # files-by-pattern, symbols-by-name, etc.
      neighbours.ts          # 1-hop / N-hop walks
      affected.ts            # affected closure for a change set
      cycles.ts              # delegate to existing SCC
      context.ts             # "what's relevant to X" bundle
    bridge/
      knowledge-bridge.ts    # link code nodes ↔ existing asset nodes
    __tests__/
      …
```

### Layer placement

```
core → workspace → config → … → boundaries → code-graph → inspector → mcp-server → cli
                                              ▲              │
                                              └──────────────┘
                                              (inspector
                                               can call into
                                               code-graph)
```

`code-graph` sits **above** `boundaries` (it uses `scanImports`) and
**alongside** but logically below `inspector` (so `shrk impact` and the
existing analyses can pull from it). It must not depend on
`mcp-server`, `cli`, or `generator`.

### What is **not** a new package

- The TS AST extractor lives inside `code-graph/indexer/` and *imports*
  `buildSymbolIndex` from `@shrkcrft/inspector`. We do not move
  `symbol-index.ts` — moving it would cascade through impact code.
- `shrk graph` continues to be a single command in
  `packages/cli/src/commands/graph.command.ts`; new sub-verbs are added
  to that file (or a sibling `graph-subcommands/` folder) and registered
  the same way.

## 5. Graph schema

The graph is a **union** of code and asset nodes; the same edge engine
serves both. Today's `knowledge-graph.ts` becomes one *projection* of
this larger graph.

### 5.1 Node kinds

```ts
export enum NodeKind {
  // — Code —
  File = 'file',
  Symbol = 'symbol',
  Package = 'package',

  // — Existing assets (bridged) —
  Rule = 'rule',
  Path = 'path',
  Template = 'template',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Pack = 'pack',
  Boundary = 'boundary',
  Knowledge = 'knowledge',
}
```

A node id is namespaced by kind to keep ids globally unique without
encoding kind in callers:

```
file:packages/inspector/src/symbol-index.ts
symbol:packages/inspector/src/symbol-index.ts#buildSymbolIndex
package:@shrkcrft/inspector
rule:no-relative-cross-package
template:cli-command
```

### 5.2 Edge kinds

```ts
export enum EdgeKind {
  // Code structure
  ImportsFile = 'imports-file',         // file → file
  DeclaresSymbol = 'declares-symbol',   // file → symbol
  ReExportsSymbol = 're-exports-symbol',// file → symbol (origin file ref)
  BelongsToPackage = 'belongs-to-package',// file → package
  PackageDependsOn = 'package-depends-on',// package → package (aggregated)

  // Symbol references (Phase 2 — recorded as 'unresolved' in MVP)
  ReferencesSymbol = 'references-symbol',     // symbol → symbol
  CallsSymbol = 'calls-symbol',               // symbol → symbol
  ExtendsSymbol = 'extends-symbol',           // symbol → symbol
  ImplementsSymbol = 'implements-symbol',     // symbol → symbol

  // Bridge to assets
  AppliesRule = 'applies-rule',         // file → rule
  ViolatesBoundary = 'violates-boundary',// file → boundary
  MatchesPath = 'matches-path',         // file → path
  CoveredByTemplate = 'covered-by-template',// file → template
  CoveredByPipeline = 'covered-by-pipeline',// file → pipeline
  ContributedByPack = 'contributed-by-pack',// node → pack
  ContainsKnowledge = 'contains-knowledge',// file → knowledge

  // Existing asset-graph edges remain as they are
  RelatedTemplate = 'related-template',
  PresetReferences = 'preset-references',
  PipelineStepReferences = 'pipeline-step-references',
  // …
}
```

### 5.3 Node and edge metadata

```ts
export interface INode {
  id: string;                 // 'file:…' | 'symbol:…' | 'package:…' | …
  kind: NodeKind;
  /** Display label — short, deterministic. */
  label: string;
  /** Optional path relative to projectRoot (for File / Symbol). */
  path?: string;
  /** Line for symbols. */
  line?: number;
  /** Free-form, kind-specific tags. */
  tags?: readonly string[];
  /** Kind-specific payload — typed per kind, validated at write. */
  data?: Readonly<Record<string, unknown>>;
}

export interface IEdge {
  /** Stable id for diffing / signing. */
  id: string;          // hash(from, to, kind)
  from: string;        // node id
  to: string;          // node id
  kind: EdgeKind;
  /** Why this edge exists — extractor name + version. */
  source: string;      // e.g. 'extract-ts-file@v1'
  /** Free-form, kind-specific metadata. */
  data?: Readonly<Record<string, unknown>>;
}
```

Kind-specific payload examples:

- `File.data`: `{ language, loc, sizeBytes, isTest, isGenerated }`.
- `Symbol.data`: `{ declKind: SymbolDeclarationKind, visibility,
  visibilityRange?: [number, number], isDefault }`.
- `ImportsFile.data`: `{ specifier, resolutionKind: 'relative' |
  'alias' | 'workspace' | 'external', line }`.
- `ViolatesBoundary.data`: `{ ruleId, severity, reason }`.

## 6. Storage format

### 6.1 JSON-on-disk (MVP)

```
.sharkcraft/graph/
  meta.json            # version, lastIndexedAt, projectRoot, fingerprintAlg
  files.json           # { "<relpath>": { mtime, sha1, lang, nodeId } }
  symbols.idx.json     # { "<name>": [ "<symbolNodeId>", … ] }   (search index)
  packages.json        # { "<pkgName>": { rootDir, nodeId } }
  nodes/
    file.jsonl
    symbol.jsonl
    package.jsonl
    bridge.jsonl       # rule/path/template/pipeline/preset/pack/boundary
  edges/
    imports-file.jsonl
    declares-symbol.jsonl
    re-exports-symbol.jsonl
    belongs-to-package.jsonl
    package-depends-on.jsonl
    violates-boundary.jsonl
    …
```

JSONL chosen over a single big JSON file for three reasons:

1. **Append-friendly.** Incremental updates can rewrite only the
   affected edge-kind file.
2. **Streaming reads.** Queries that only care about
   `imports-file` don't pay to load `declares-symbol`.
3. **Git-diffable.** Reviewers and `shrk dashboard` can show
   meaningful diffs across reindexes.

### 6.2 Why not SQLite first

- Adds a native dependency (`better-sqlite3` or similar) — friction on
  install, especially in CI environments without build toolchains.
- For repos under ~5k files (which is SharkCraft itself many times
  over), JSONL + an in-memory map is fast enough.
- The query API is the public contract; the store is internal. Swapping
  to SQLite later does not break callers.

### 6.3 When to upgrade to SQLite

Promote when **any** of these is true:

- Cold-start load time of the JSONL store exceeds 300 ms for a repo we
  care about.
- Symbol search (`shrk graph search`) takes more than 50 ms.
- The store totals more than ~50 MB on disk uncompressed.

The migration is a one-time, behind-the-store, file-format change.
Manifest version (`sharkcraft.code-graph/v1` → `v2`) drives the upgrade.

### 6.4 Determinism + signing

Every JSONL line ends in a newline; every node/edge id is deterministic
(content-derived); fingerprints use SHA-1 of file content + mtime. The
graph's `meta.json` includes a top-level `digest` (SHA-256 of all
JSONL files concatenated) so callers can detect stale or tampered
indexes. This matches the existing HMAC-signed plan pattern used by the
generator.

## 7. TypeScript parser strategy

**Use single-file `ts.createSourceFile`, not `ts.createProgram`.**

Reasoning:

- We already do this in `buildSymbolIndex`. Switching to a full Program
  would slow indexing by ~10–100× on a repo of SharkCraft's size and
  require an in-memory type checker, which we do not need for
  graph-shaped queries.
- The IDE-perfect resolution that `ts.Program` gives us (cross-file
  inference, structural type identity, etc.) is unnecessary for the
  agent-shaped questions we want to answer.
- Anything that genuinely needs `ts.Program` (e.g. inferred return
  types across modules) can be added in a Phase 2 *enrichment* pass,
  opt-in and behind a flag.

### What we extract per file

1. **Imports** — re-use `scanImports` for line and specifier. Add an
   `extract-ts-file.ts` step that walks the AST once to refine the
   regex output:
   - Confirm each import is a real import (filter false positives from
     the regex).
   - Capture imported symbol names so we can later wire
     `references-symbol` edges to the symbols they bind to.
   - Mark dynamic imports (`import(...)`) and type-only imports.
2. **Exports / locals / re-exports** — call `buildSymbolIndex` and lift
   its output into `symbol` nodes + `declares-symbol` /
   `re-exports-symbol` edges.
3. **File metadata** — language, loc, sizeBytes,
   `isTest = /\.(spec|test)\.[tj]sx?$/`, `isGenerated = first 5 lines
   contain '@generated' or known SharkCraft generator banner`.

### What we do **not** extract (yet)

- Function call sites and identifier references. These need either a
  binder pass or a `ts.Program`. The schema *reserves* `references-
  symbol` / `calls-symbol` edges; the MVP extractor simply does not
  emit them. Phase 2 lights this up.
- Type structure (return types, parameter types). Out of scope.

### Throughput target

Single-file `createSourceFile` does ~1k–5k files/second on a modern
laptop. For a repo of 2k TS files, full reindex must complete in **<
3 s** wall-clock; incremental reindex (a handful of changed files)
must complete in **< 100 ms**. These are testable budgets in the
`code-graph` package tests.

## 8. Path alias and import resolution

The current import scanner stops at `internal vs external`. For the
graph to be useful, `@shrkcrft/inspector` must resolve to
`packages/inspector/src/index.ts`. The resolver is the single most
important new piece of code in the indexer.

### 8.1 Inputs

- `tsconfig.base.json` → `compilerOptions.paths` (mapped aliases).
- `package.json` workspaces (or pnpm/yarn workspaces) → workspace
  packages and their `main` / `exports` entrypoints.
- `nx.json` → workspace layout (`workspaceLayout.projectsDir`).
- Each workspace package's own `package.json` for `name`, `exports`,
  `main`, `module`, `types`.

### 8.2 Resolver order

For each import specifier in a source file:

1. **Relative** (`./foo`, `../bar`) — resolve against the file's
   directory; probe `.ts`, `.tsx`, `.js`, `/index.ts`, `/index.tsx`,
   `/index.js` in that order.
2. **tsconfig alias** — match against `paths`; if the mapped target is
   inside the workspace, follow step 4; if outside, mark `external`.
3. **Workspace package name** (e.g. `@shrkcrft/inspector`) — look up
   the package, use its `exports['.']` or `main`, then probe like
   step 1.
4. **Probe** the resolved candidate, recording the first hit. If none
   exists, emit a `unresolved-import` diagnostic and tag the edge as
   `resolutionKind: 'external'`.
5. **External** otherwise. We still record the edge with the literal
   specifier so the agent can ask "which npm packages does this file
   pull in?".

### 8.3 Nx project graph

Nx already builds a project graph. We treat it as **one input among
several** — not the source of truth — for two reasons:

- Nx's graph is project-level, not file-level. We need file-level.
- Some SharkCraft consumers will be plain TS monorepos with no Nx. The
  resolver must work without `nx` installed.

Where Nx **is** available, we read its cached project graph
(`nx graph --file=...` or programmatic API via `@nx/devkit`) to:

- Speed up workspace discovery (no need to walk `packages/*`).
- Confirm package boundaries when constructing
  `package-depends-on` aggregate edges.
- Surface Nx-tagged constraints (`@nx/enforce-module-boundaries`) as
  inputs to our existing boundary engine.

If Nx is not present, fall back to `package.json` workspaces detection
(already implemented in `import-graph-analysis.ts`).

## 9. Indexing pipeline

### 9.1 Full reindex

```
fullIndex(projectRoot) → IGraphFingerprint
  1. Discover packages          (workspaces + Nx + tsconfig)
  2. Walk source files          (respect .gitignore + DEFAULT_IGNORE)
  3. For each file in parallel:
       a. fingerprint(file)     (mtime + sha1)
       b. extract-ts-file       (imports + symbols + metadata)
       c. resolve-imports       (alias + workspace + external)
       d. emit nodes + edges    (buffered per kind)
  4. Compute derived:
       – package-depends-on aggregates
       – cycles                (Tarjan over imports-file)
       – orphans, fan-in/out   (delegated to existing analysis)
  5. Bridge:
       – violates-boundary     (run boundary engine on imports edges)
       – matches-path          (from paths registry)
       – covered-by-template   (from templates registry)
  6. Write store:
       – meta.json, files.json, packages.json, symbols.idx.json
       – nodes/*.jsonl, edges/*.jsonl
  7. Return digest + counts.
```

Parallelism: TypeScript parsing is CPU-bound; we run extraction in a
worker pool sized to `Math.max(2, os.cpus().length - 1)`. Workers
return plain data; the main thread owns the store.

### 9.2 Incremental update

```
update(changedFiles, deletedFiles) → IGraphFingerprint
  1. For each deletedFile:
       – remove File node, all DeclaresSymbol edges originating there,
         all Symbol nodes whose owning file is gone.
       – remove ImportsFile edges originating in deletedFile.
       – mark target packages as candidates for PackageDependsOn rebuild.
  2. For each changedFile:
       – recompute fingerprint; if unchanged, skip.
       – re-extract symbols + imports.
       – diff old vs new node/edge set; apply additions + removals.
  3. Rebuild affected packages' PackageDependsOn aggregates.
  4. Re-run cycle detection (cheap once edges are in memory).
  5. Re-run bridge passes for impacted files only.
  6. Write delta — append to JSONL for adds, rewrite kind-file when
     removals exceed 30 % of lines (compaction threshold).
  7. Update meta.json + files.json.
```

### 9.3 Triggers

- `shrk graph index` — explicit full reindex.
- `shrk graph index --changed` — diff against `files.json` fingerprints
  and update only what changed. This is what CI and pre-hooks call.
- `shrk graph index --since <gitref>` — driven by `git diff --name-only`.
- Auto-trigger on `shrk impact`, `shrk graph search`, etc. **if** the
  index is older than 10 min **and** a `--no-auto-index` flag is not
  set. Auto-trigger only runs `--changed`, never a full reindex.

No file watcher / daemon in MVP. Explicit, predictable, scriptable.

### 9.4 What lives in `.sharkcraft/graph/` vs `.sharkcraft/cache/`

- `.sharkcraft/graph/` is the **authoritative** index. It is durable
  across runs and may be checked in (we ship a `.gitignore` line by
  default, but teams can opt-in to committing it).
- `.sharkcraft/cache/` continues to hold ephemeral inspector caches,
  unaffected by this work.

## 10. CLI surface

The new sub-verbs live under the existing `shrk graph` command. None
conflict with the existing `shrk graph <id>` / `shrk graph export`
patterns because they all start with a distinct keyword.

| Command | Purpose |
|---|---|
| `shrk graph index` | Build / rebuild the on-disk index. `--changed`, `--since <ref>`, `--full`, `--json`. |
| `shrk graph status` | Print index health: lastIndexedAt, files counted, dirty count (mtime drift), digest, stale flags. `--json`. |
| `shrk graph search <query>` | Search nodes by name, file path glob, or symbol prefix. Filters: `--kind file|symbol|package`, `--package <name>`, `--limit N`. `--json`. |
| `shrk graph context <fileOrSymbol>` | "What's relevant here?" — neighbours, declared symbols, importers up to depth 2, applicable rules / templates / paths, likely tests. `--depth N`, `--json`. |
| `shrk graph impact <fileOrSymbol\|--since <ref>\|--files a,b>` | Reverse closure of importers + bridge edges (boundary risks, owners, affected templates / pipelines). Backs `shrk impact`. `--max-depth`, `--limit`, `--json`. |
| `shrk graph why <a> <b>` *(exists)* | Shortest path between two nodes. Unchanged. |
| `shrk graph` *(exists)* | Knowledge-graph projection. Unchanged. |
| `shrk graph export` *(exists)* | File export. Now offers `--include code` to include code nodes. |

### Output discipline

Every command supports `--json` returning the same payload an MCP tool
would return. Default text output is short, scannable, and
deterministic (sorted lists, no timestamps unless `--json`).

### Failure modes

If the index is missing or stale, every read command:

1. Prints a one-line hint ("Index is stale. Run `shrk graph index
   --changed` to refresh.").
2. Either auto-runs `--changed` (default) or bails (`--no-auto-index`).

Never silently return wrong answers from a stale index. The status
field in JSON output (`indexState: 'fresh' | 'stale' | 'missing'`) is
always populated.

## 11. MCP surface

All read-only, all return the same JSON the CLI emits with `--json`.

```
get_graph_status
get_graph_search
get_graph_context
get_graph_impact
get_graph_neighbours
graph_why                    (existing — extended to span code nodes)
```

The MCP server never writes the index. If `get_graph_status` reports
`indexState: 'missing'`, every other tool returns a structured error
with `nextCommand: 'shrk graph index'` — exactly how onboarding,
apply, and generation already work.

## 12. AI-agent consumption patterns

The whole layer is shaped around three agent questions:

### 12.1 "Which files are relevant to this task?"

Agent calls `get_graph_context` with a free-text query (which is
resolved against the symbol search index + path patterns), or with a
specific file. Response contains:

- Anchor node (the file or symbol).
- Direct neighbours: files this imports, files that import it.
- Declared symbols (or, if anchor is a symbol, sibling symbols in the
  file).
- Applicable rules, path conventions, templates.
- Likely tests (co-located + conventional).
- A capped, ranked list — never returns 500 files.

This subsumes a chunk of what `shrk context --task` does today for
code-shaped questions.

### 12.2 "What depends on what?"

Agent calls `get_graph_neighbours` for a 1-hop view or `graph_why`
for a path between two nodes. For aggregated views the agent uses
`get_graph_search --kind package` to enumerate packages and pull
their `package-depends-on` edges.

### 12.3 "What will this change affect?"

Agent calls `get_graph_impact` with either a file list, a git ref, or
a symbol id. Response is the impact payload — same `IImpactAnalysis`
shape as today, but produced from the indexed graph instead of a fresh
walk. Latency target: < 50 ms for typical commits.

### Agent-shaped niceties (free wins from a persistent graph)

- **Stable ids** — agents can persist node ids across turns. Today the
  agent has to re-derive paths every call.
- **Capped, ranked output** — every list has `truncated: bool` and
  ranking criteria spelled out. Agents don't need to guess what was
  cut.
- **`nextCommand` hints** — when a query touches a stale / missing
  edge, the response carries a CLI command the human (or the agent in
  CLI mode) can run to fix it.

## 13. Connections to existing SharkCraft systems

| System | Today | After code-graph |
|---|---|---|
| `shrk impact` | Re-scans every call via `scanImports` | Reads pre-built `imports-file` edges; same payload shape, lower latency |
| Boundary engine | Runs against ad-hoc scan results | Runs against `imports-file` edges; `violates-boundary` edges are persisted |
| `shrk graph` (knowledge) | Knowledge-only view | Unchanged surface; underlying store is the unified graph |
| `shrk context --task` | Heuristic ranker over rules / paths / templates | Adds code-relevance: top files by symbol/path match, top importers |
| Templates registry | Knows file path patterns | Bridge edges (`covered-by-template`) make "this file is generated from template X" explicit |
| Rules registry | Path-glob based | Bridge edge `applies-rule` makes "which rules apply to this file?" a 1-hop query |
| `shrk doctor` | Independent checks | New checks: "graph stale", "files missing from graph", "unresolved imports", "cycles increased since last index" |
| `shrk coverage` | Asset-coverage | Adds *code-coverage*: % of files indexed, % with cycles, etc. |
| `shrk drift` | Drift across registries | Adds drift between graph fingerprint and current workspace state |
| Quality gates (Phase 3) | n/a | Bridge `quality-gate` nodes to `file` nodes via `gates-file` edges |
| `shrk apply` | Plan-level | Plan-level *and* graph-level: a plan's affected files are a graph query |

The unifying claim: **the agent calls one graph, not ten subsystems.**

## 14. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Index goes stale silently | High if auto-update is off | Always populate `indexState`; default to auto-update with explicit opt-out |
| Resolver false negatives (alias misconfig) | Medium | `unresolved-import` diagnostics surfaced in `shrk graph status`; `shrk doctor` warns |
| Symbol name collisions (two `IFoo` in different packages) | Certain | Symbol node id includes file path; search returns *all* matches with package prefix; agent picks |
| Cold-start cost on large repos | Medium | Worker pool; budget < 3 s for 2k files; SQLite migration trigger documented |
| Disk footprint growth | Low | JSONL compaction at 30 % churn; `meta.json.maxBytes` warning |
| Schema churn breaks consumers | Medium | `schema: 'sharkcraft.code-graph/v1'` on every payload; migration handled in `code-graph/store/manifest.ts` |
| Duplicating existing primitives | High if undisciplined | Re-export via `code-graph` rather than re-implement; tests assert single source of truth |
| MCP accidentally writes | Forbidden | MCP tools never construct an `IndexBuilder`; only call query API. Boundary rule blocks the import |
| Nx absence breaks workspace detection | Low | Resolver tries Nx → workspaces → tsconfig in order; only the cheapest path is mandatory |
| Watcher / daemon temptation | Medium | Explicit non-goal in MVP; revisit only when measured CLI-trigger latency hurts agent flow |

## 15. Phased roadmap

### Phase 1 — MVP (target: ~3 rounds)

- `@shrkcrft/code-graph` package skeleton.
- Schema (node-kinds, edge-kinds, types, schema-version).
- JSONL store + manifest + file fingerprints.
- TS file extractor (re-uses `buildSymbolIndex` + `scanImports`).
- Path-alias + workspace resolver. Nx-graph integration optional.
- Full + incremental indexing.
- CLI: `shrk graph index | status | search | context | impact`.
- MCP: read-only equivalents.
- `shrk impact` rewired to read from the graph (kept signature-stable).

Exit criteria: an agent can answer the three core questions with one
MCP call each, with < 100 ms latency on the SharkCraft monorepo.

### Phase 2 — Symbol references

- Resolver pass that links `import { foo } from '...'` to the
  declared `symbol:` node in the resolved file.
- `references-symbol` extraction via AST identifier walk (still no
  `ts.Program`).
- `calls-symbol`, `extends-symbol`, `implements-symbol` for cases
  cheap to detect at the AST level.
- `shrk graph search --kind symbol` becomes precise (no more text
  fallback for symbols we've indexed).
- New CLI: `shrk graph callers <symbol>`.

### Phase 3 — SharkCraft semantics

- Bridge nodes for plugins, plugin contracts, capabilities, policies,
  adapters, generated files, quality gates, agent tests.
- `applies-rule`, `covered-by-template`, `gates-file`,
  `generated-from` edges.
- Affected-tests resolver (`code-graph + test-impact` integration).
- `shrk graph contract <pluginId>` etc.

### Phase 4 — Multi-language (only if demand)

- Language extractors for Java, C#, Python, Go, Rust slot in behind a
  `Language` enum. Each extractor returns the same `{ symbols, imports,
  metadata }` shape and the rest of the pipeline is unchanged.
- SQLite swap if measured needed.

### Phase 5 — Optional enrichment (only if demand)

- A `ts.Program`-backed enrichment pass that computes inferred types
  and structural identity, on demand, for narrow queries
  (`shrk graph type <symbol>`).
- File watcher for IDE-style flows. Still no daemon — a short-lived
  watcher process that exits on idle.

## 16. Open design questions

These do not block the design; they are flagged for early
implementation decisions:

1. **Re-export collapsing.** When `A` re-exports `foo` from `B`,
   should an `imports A` edge resolve to `symbol:B#foo` directly, or
   leave the agent to follow `re-exports-symbol`? *Proposal:* leave
   the indirection but expose a `--resolve-reexports` flag on
   `search` / `context` for convenience.
2. **Test/spec marking.** Should test files be a separate node kind
   or just a tag on `File`? *Proposal:* tag, not kind. Keeps the
   schema tight.
3. **Generated files.** Same question for `@generated` files.
   *Proposal:* tag + a `generated-from` edge when the template is
   known.
4. **Type-only imports.** Do they get their own edge kind?
   *Proposal:* same `imports-file` edge with
   `data.typeOnly: true` — avoids edge-kind explosion.
5. **Index location override.** Should `code-graph` accept
   `$SHARKCRAFT_GRAPH_DIR` so monorepos can park it outside the
   working tree? *Proposal:* yes — but keep the default in-tree for
   discoverability.

## 17. What success looks like

After Phase 1 ships, the following are true:

- An agent answers "which files in this repo handle pack signing?"
  with **one** MCP call (`get_graph_search` + `get_graph_context`).
  Today it costs three or four.
- `shrk impact src/foo.ts` returns in well under 100 ms on
  SharkCraft itself.
- `shrk doctor` includes graph health and points the human at the
  right command when it's wrong.
- Every existing code-level analysis (`shrk impact`,
  `shrk check boundaries`, fan-in/out, cycle detection) reads from
  the same graph, removing the current scatter of in-memory walks.
- Asset-side commands (`shrk graph`, `shrk context --task`) gain
  code-aware ranking without changing their public surface.

That's the bar: fewer agent tool calls, lower latency, single source
of truth — without the safety contract loosening anywhere.
