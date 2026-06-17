# Code intelligence roadmap

> **Status: planning document, not published.** A long-horizon roadmap
> for the seven packages that together turn `shrk` from a registry of
> static knowledge into a live, queryable model of the repository.
>
> The companion design for the foundation lives in
> [`code-intelligence.md`](code-intelligence.md). This file is the
> superset: it covers the other six packages, the order they should
> ship in, what each wave delivers, and the risks.

## Status snapshot (live)

| Wave | Package | Status | Notes |
|---|---|---|---|
| 1 — Foundation | `@shrkcrft/graph` | **shipped (R63)** | persistent JSONL store; CLI + MCP live |
| 1 — Foundation (R64) | incremental indexing | **shipped (R64)** | `--changed`, `--since <ref>`, `--full` flags |
| 2 — Bridges | `@shrkcrft/rule-graph` | **shipped (R66–R68 + knowledge-rule bridges)** | bridges code files to rules / paths / templates; IKnowledgeEntry rules via metadata.appliesTo + tag heuristic |
| 3 — Symbol refs | (inside `@shrkcrft/graph`) | **shipped (light)** | `references-symbol`, `calls-symbol` edges; `shrk graph callers` |
| 4 — Structural search | `@shrkcrft/structural-search` | **shipped (R72–R74)** | declarative AST pattern DSL; query-only |
| 5 — Architecture guard | `@shrkcrft/architecture-guard` | **shipped (R76–R79 + adapter-leak)** | public-API misuse, barrels, cycle severity, contract DSL, adapter-leak heuristic |
| 6 — Context planner | `@shrkcrft/context-planner` | **shipped (R80–R83 light)** | intent classifier + ranker + token budget |
| 2 — Impact engine | `@shrkcrft/impact-engine` | **shipped (R69–R71)** | v3 payload; rule-graph aware; `--full` on `shrk graph impact`; `shrk impact --via-graph` flag |
| 7 — Framework scanners | `@shrkcrft/framework-scanners` | **shipped — NestJS, React, Express, Next.js, Angular, Vue, Svelte, Fastify, FastAPI, Solid, Astro, Django, Flask, Spring, Rails, Phoenix + pack-contributed extractor loader** | 16 built-in extractors via the plugin contract. Spring (Java + Kotlin) covers stereotypes + `@*Mapping` routes with class/method path composition. Rails (Ruby) detects `ApplicationController` subclasses + their public action methods, `ApplicationRecord`/`ActiveRecord::Base` models, and `routes.rb` DSL entries (`resources`, `resource`, verb-style routes with `=>` or `to:`). Phoenix (Elixir) binds modules to roles via their `use` declarations: `:controller` → controller + actions, `:router` → router + per-verb route entries combining `verb path, Controller, :action`, `Ecto.Schema` → schema, `Phoenix.LiveView`/`LiveComponent` → live components. |
| 8 — Structural rewrite | (extends `structural-search`) | **shipped — incl. HMAC-signed plans** | declarative recipes: `replace-identifier-name`, `replace-call-callee`, `replace-import-from`. Preview by default; `--apply` writes; drift detection; saved plan replay. `--sign` / `--verify-signature` for HMAC-SHA256 signed plans (schema `sharkcraft.structural-rewrite-plan-signed/v1`) — brings rewrites under the same safety contract as the rest of SharkCraft. |
| Code intelligence add-ons | `@shrkcrft/api-surface-diff` | **shipped — incl. ts.Program-backed signatures + generic normalization + persistent cache** | diffs public exports between two graph snapshots; reports added / removed / kind-changed / moved-file / moved-package / signature-changed with severity. `--with-signatures` builds a `ts.Program` and captures canonical signature strings (structural for interfaces/classes/type aliases, call-signature for functions) so parameter/return/member changes are detected as breaking. Generic type-parameter names are substituted with positional placeholders (`__P0`, `__P1`) so a `T → U` rename is not flagged as a breaking change; adding a constraint or a new type parameter still is. Per-symbol signatures are persisted at `.sharkcraft/api-surface/signatures.json` (schema `sharkcraft.api-surface-cache/v1`) keyed by per-file SHA1, so re-runs over unchanged files skip the type-checker call. CLI: `--no-cache` to force a full rebuild. |
| Code intelligence add-ons | `@shrkcrft/quality-gates` | **shipped** | single `shrk gate` aggregator: graph freshness + architecture + impact-since-ref + (optional) api-surface-diff → one pass/fail. Schema `sharkcraft.quality-gate-report/v1` |
| Code intelligence add-ons | `@shrkcrft/migrate` | **shipped — incl. checkpoint / resume + prune** | multi-step migration orchestrator: structural rewrites + shell + checks in one replayable plan. Per-step checkpoint at `.sharkcraft/migrations/<id>.state.json` + `shrk migrate resume <id>` picks up at the failed step. `shrk migrate prune --older-than <days>` deletes stale state files (failed entries kept by default; `--include-failed` to clear them too). Schema `sharkcraft.migration/v1` + `sharkcraft.migration-run/v1` + `sharkcraft.migration-prune/v1`. |
| Cross-language graph | `@shrkcrft/graph` (multi-language dispatcher) | **shipped — Python, Go, Java, Rust, Kotlin, Ruby, C#, Elixir** | `.py`, `.go`, `.java`, `.rs`, `.kt`/`.kts`, `.rb`, `.cs`/`.csx`, `.ex`/`.exs` are first-class graph nodes. Elixir: `defmodule Path.To.Mod do` → module symbol; `def`/`defp` → function (exported / local); `defprotocol` → interface; `defstruct` → class. Imports: `alias`/`import`/`require`/`use`, including brace-group `alias Foo.{A, B}` expansion. File-level `elixirModule` captured for the first `defmodule`. |
| Dashboard surface | `packages/dashboard` (browser UI) | **shipped — code-intelligence + routes + migrations + quality-gates + architecture + graph panels SSE-aware + persisted gate report** | Six panels listen on the `/api/events` SSE stream and refetch on relevant changes: `/code-intelligence`, `/routes`, `/migrations`, `/quality-gates`, `/architecture`, `/graph` (Knowledge Graph). Per-page event filter on `useLiveApi(fetcher, live, eventFilter?)` so each panel only refetches on the events it cares about. Quality-gate panel reads `.sharkcraft/quality-gates/last.json` (written by `shrk gate`) when fresh (<5 min) and falls back to running the gate inline + persisting otherwise. |
| Doctor integration | code-intelligence checks in `runDoctor` | **shipped — all §5.5 promises met + gated in `shrk gate` + documented in docs/doctor-code-intelligence.md + zero-config starters** | `buildCodeIntelligenceChecks(projectRoot)` reads each package's persisted state file (`.sharkcraft/{graph,bridge,api-surface,quality-gates,migrations,architecture,impact,framework,structural,context-planner}/...`) and emits findings bucketed under `category: 'code-intelligence'`. Fourteen check ids: `code-intelligence-graph` + `-graph-cycles` + `-graph-unresolved`, `-rule-graph` + `-rule-coverage`, `-api-surface`, `-quality-gate`, `-migrations`, `-architecture`, `-impact` + `-impact-baseline`, `-framework`, `-structural-search`, `-context-planner`, plus cross-store `-schema-mismatch`. Gated CI surface: `shrk gate` now includes `graph-cycles`, `graph-unresolved`, `impact-baseline`, `structural-patterns`, `intent-classifier` alongside the existing `graph-fresh / arch / impact / api-diff` gates. Zero-config adoption helpers: `shrk search-structural registry seed` (7 starter patterns) and `shrk context benchmark seed` (21-case starter intent fixture, ≥ 90% baseline accuracy). Authoritative reference: `docs/doctor-code-intelligence.md` documents every check id end-to-end. Inspector still does not depend on any code-intelligence package. |

**12 new packages live** — `@shrkcrft/graph`, `@shrkcrft/rule-graph`,
`@shrkcrft/structural-search`, `@shrkcrft/impact-engine`,
`@shrkcrft/context-planner`, `@shrkcrft/architecture-guard`,
`@shrkcrft/framework-scanners`, `@shrkcrft/api-surface-diff`,
`@shrkcrft/quality-gates` (plus the existing `@shrkcrft/boundaries`
and `@shrkcrft/inspector` they build on).

**19 new MCP tools** in the code-intelligence surface (`get_graph_*`
family, `get_rules_for_file`, `get_structural_search`,
`get_structural_codemod_plan`, `get_graph_impact_analysis`,
`get_context_pack`, `get_arch_violations`, `get_framework_entities`,
`get_api_surface_diff`, `get_quality_gate`).

See §8 for the updated success-criteria table.

## 0. Executive review of the 7-package partition

The partition you sketched is sound at the **product** level — it
names seven real, distinct surfaces an AI agent needs. At the
**engineering** level it has three issues worth solving before code
starts:

| Issue | Why it matters | Recommendation |
|---|---|---|
| **Granularity.** Seven packages doubles the surface area of the engine. Every package needs schema, store, tests, doctor checks, MCP tools, dashboard view, docs. | Maintenance compounds. Half-finished risk per package is real. | Keep the seven packages, but make at least two of them **thin shells** over deeper code (`impact-engine`, `rule-graph`). Avoid copying logic into them. |
| **Foundation coupling.** Six of the seven depend on `@shrkcrft/graph`. If the graph schema thrashes, everything else has to follow. | Schema thrash is a serial bottleneck. | Lock the graph schema *first*, behind `sharkcraft.graph/v1`. No downstream package starts until v1 is sealed. Schema breaking changes after that require an explicit `v2` and a documented migration. |
| **Overlap with what's already shipped.** `boundaries`, `inspector/import-graph-analysis`, `inspector/symbol-index`, `inspector/impact-graph`, `shrk graph` (assets) all exist today. | New packages risk re-implementing what's already there. | Every new package starts by **importing** the existing primitive, not re-writing it. Wave 1's first PR is "wrap, don't replace." |

Three other product calls worth making explicit:

1. **`architecture-guard` is bigger than `boundaries`.** The existing
   `boundaries` package does lexical layer-order checks. The proposed
   `architecture-guard` also covers public-API misuse, barrel risks,
   adapter/business-logic leaks, and project-specific architecture
   contracts. Keep `boundaries` as the mechanical scanner; build
   `architecture-guard` *on top* — don't merge the two.
2. **`impact-engine` is mostly a refactor.** `shrk impact` already
   computes 80 % of what you describe. The new package is where the
   impact logic *lives*; the work is extraction + plumbing + adding
   rule/template/generated-file awareness, not re-inventing impact.
3. **`framework-scanners` is a plugin pattern, not a monolith.** Ship
   one extractor per framework, each implementing the same
   `IFrameworkExtractor` contract. The first three (NestJS, Angular,
   React) prove the pattern; the rest follow as separate packages or
   scanner-shaped contributions inside one package — either works.

## 1. Final package set (after consolidation)

Same seven packages you proposed, with sharpened scope and explicit
overlap with existing code:

| # | Package | Status today | New work |
|---|---|---|---|
| 1 | `@shrkcrft/graph` | None — uses primitives from `boundaries`, `inspector` | Persistent store, resolver, indexer, query API, CLI verbs, MCP tools |
| 2 | `@shrkcrft/rule-graph` | None — assets exist in `rules`, `paths`, `templates`, `pipelines`, `presets`, `packs`, `boundaries` | Bridge nodes + bridge-query API that links assets to graph nodes |
| 3 | `@shrkcrft/impact-engine` | `shrk impact` + `inspector/impact-graph.ts` exist | Extract impact logic from `inspector`, rebuild on graph + rule-graph, add risk scoring + test/template/generated awareness |
| 4 | `@shrkcrft/structural-search` | None — `inspector/symbol-index.ts` does per-file AST | Pattern DSL, AST matcher engine, rule-bound queries, preview mode, rewrite (later) |
| 5 | `@shrkcrft/architecture-guard` | `boundaries` does layer/forbidden-import checks | Public-API misuse, barrel risks, adapter leaks, project architecture contracts, suggested fixes |
| 6 | `@shrkcrft/context-planner` | `shrk context --task` exists | Compact context packs, token budgeting, intent detection, do-not-touch zones, agent-specific formatting |
| 7 | `@shrkcrft/framework-scanners` | None | Plugin-shaped extractors that enrich the graph with NestJS / Angular / React / Express semantics; later Fastify, Next.js, Electron, Vue, Svelte |

## 2. Layer placement

Inserted between the current `boundaries` layer and the existing
`inspector` layer. Lower cannot import higher.

```
core → workspace → config → knowledge → rules/paths/templates/pipelines/presets/boundaries
     ↓
     ├── graph
     │    ├── structural-search       (uses graph file enumeration + AST cache)
     │    ├── rule-graph              (bridges to asset registries above)
     │    └── framework-scanners      (enrichment plugins; one per framework)
     ↓
     ├── architecture-guard           (uses graph + structural-search + rule-graph)
     ├── impact-engine                (uses graph + rule-graph + framework-scanners)
     ↓
     └── context-planner              (uses all of the above)
                ↓
              packs → generator → importer → inspector → mcp-server → cli
```

`inspector` is **above** the new code-intelligence layer and is allowed
to consume it; that's the path by which existing `shrk impact`,
`shrk graph`, and `shrk doctor` get upgraded without touching their
public surfaces.

## 3. Package-by-package detail

### 3.1 `@shrkcrft/graph` — the foundation

**Purpose.** A persistent, incrementally-updated graph of files,
folders, packages, Nx projects, imports, exports, symbols, and
public APIs. The single source of truth that every other package
queries.

**Scope (in).**
- TypeScript-first (TS/TSX/JS/JSX/MJS/CJS).
- File / folder / package / symbol nodes.
- `imports-file`, `declares-symbol`, `re-exports-symbol`,
  `belongs-to-package`, `package-depends-on` edges.
- Path-alias + workspace + Nx resolution.
- Persistent JSONL store under `.sharkcraft/graph/`.
- Full + incremental indexing.
- Query API: by id, by name prefix, by path glob, by package, by
  fan-in/fan-out, by cycle.
- CLI: `shrk graph index | status | search | context | impact`
  (final form in §3.6 for `context`, §3.3 for `impact`).
- MCP: read-only equivalents.

**Scope (out, deferred).**
- Symbol *references* (Wave 3). MVP records declarations and
  re-exports only.
- Multi-language (Wave 9+, demand-driven).
- File watcher / daemon.
- SQLite store. JSONL until measured insufficient.

**Surface.**
```ts
// @shrkcrft/graph
export interface IGraphQueryApi {
  status(): Promise<IGraphStatus>;
  findFile(path: string): IFileNode | null;
  findSymbol(name: string, opts?: { kind?: NodeKind; package?: string }): readonly ISymbolNode[];
  importersOf(fileOrSymbolId: string, opts?: { depth?: number }): readonly INode[];
  importsFrom(fileOrSymbolId: string, opts?: { depth?: number }): readonly INode[];
  packageDeps(pkg: string): readonly string[];
  cycles(): readonly IGraphCycle[];
  why(from: string, to: string): IGraphPath | null;
}

export interface IGraphBuilder {
  fullIndex(projectRoot: string): Promise<IGraphFingerprint>;
  updateChanged(projectRoot: string, files?: readonly string[]): Promise<IGraphFingerprint>;
}
```

**Detailed design.** See [`code-intelligence.md`](code-intelligence.md).
That document is the technical contract for this package.

**Rounds.** R63 (schema + store + extractor), R64 (resolver + Nx +
incremental), R65 (CLI + MCP + rewire `shrk impact`).

**Exit criteria.**
- All existing code-level analyses (`shrk impact`, `shrk check
  boundaries` fast path, fan-in/out, cycles) read from
  `@shrkcrft/graph`.
- Cold full index on the SharkCraft monorepo: < 3 s.
- Incremental reindex of a 5-file change: < 100 ms.
- `get_graph_context` returns a useful neighbour set in < 50 ms.
- No regression on `shrk impact` output (snapshot tests).

### 3.2 `@shrkcrft/rule-graph` — bridge to the asset layer

**Purpose.** Turn shrk's *static* rules/templates/presets/quality
gates/ownership data into edges attached to the code graph.
Answers "which rules apply to file X?", "which template generated
this file?", "which quality check validates the result?" with a
1-hop query.

**Scope (in).**
- Bridge node kinds (re-using existing asset ids — no duplication):
  `rule`, `path`, `template`, `pipeline`, `preset`, `pack`, `boundary`,
  `knowledge`, `ownership`, `quality-gate`.
- Bridge edges: `applies-rule`, `matches-path`, `covered-by-template`,
  `covered-by-pipeline`, `contributed-by-pack`, `gated-by`, `owned-by`,
  `contains-knowledge`.
- Bridge query API: `rulesFor(file) → IRuleNode[]`,
  `templatesThatGenerated(file) → ITemplateNode[]`, etc.
- Bridge build pass that runs as the last step of full + incremental
  indexing.

**Scope (out).**
- Authoring rules / templates / etc. — those stay in their existing
  packages.
- Inferring new bridge edges where the asset data is ambiguous —
  this package is deterministic; ambiguity surfaces as a diagnostic.

**Surface.**
```ts
export interface IRuleGraphQueryApi {
  rulesFor(nodeId: string): readonly IRuleEdgeHit[];
  pathsMatching(nodeId: string): readonly IPathEdgeHit[];
  templatesCovering(nodeId: string): readonly ITemplateEdgeHit[];
  pipelinesCovering(nodeId: string): readonly IPipelineEdgeHit[];
  qualityGatesFor(nodeId: string): readonly IQualityGateEdgeHit[];
  ownersOf(nodeId: string): readonly IOwnershipEdgeHit[];
}
```

**Detailed design.** Thin shell. Reads from `@shrkcrft/graph` for
file/symbol/package nodes; reads from existing asset registries
(`@sharkcraft/rules`, `@sharkcraft/paths`, `@sharkcraft/templates`,
…) for the asset side. Emits its bridge edges into a separate
`bridge.jsonl` file under `.sharkcraft/graph/edges/`.

**Rounds.** R66 (bridge node + edge schema), R67 (bridge build pass +
query API), R68 (`shrk rules where applies-to <file>` and MCP).

**Exit criteria.**
- `get_rules_for_file` returns the same data as a current
  hand-written walk over the rules registry, but in one call.
- Bridge edges round-trip through `shrk graph export` and
  `shrk graph why`.
- Doctor check: bridge coverage gap (files with no applicable rule
  flagged).

### 3.3 `@shrkcrft/impact-engine` — change blast-radius

**Purpose.** "What does this change affect?" Combines graph
reachability with rule-graph bridges, ownership, test mapping, public
API exposure, and a risk score. Backs `shrk impact` and the
`get_impact_analysis` MCP tool.

**Scope (in).**
- File-level impact: direct + transitive importers (closure over
  `imports-file`).
- Symbol-level impact (Wave 3-aware): direct callers, type referencers.
- Package-level impact: `package-depends-on` closure.
- Bridge-aware impact: affected rules, templates, pipelines,
  generated files, quality gates, ownership.
- Test mapping: likely tests via co-location, naming convention, and
  bridge edges to test pipelines.
- Risk score (`low | medium | high | critical`) with explicit reasons.
- Validation scope: which `shrk check / test / boundaries` commands
  to run before/after the change.
- Public-API exposure flags: does the change touch an exported symbol
  at a workspace-package boundary?

**Scope (out).**
- Test runner integration — impact-engine *names* tests to run, but
  does not run them.
- LLM-derived risk — risk uses deterministic heuristics only.
- Cross-repo impact — single repo at a time.

**Surface.**
```ts
export interface IImpactEngine {
  analyze(input: IImpactInput): Promise<IImpactAnalysis>;
}

export type IImpactInput =
  | { kind: 'files'; files: readonly string[] }
  | { kind: 'gitref'; ref: string; staged?: boolean }
  | { kind: 'plan'; planPath: string }
  | { kind: 'symbol'; symbolId: string };
```

`IImpactAnalysis` keeps the existing `sharkcraft.impact-analysis/v2`
shape and extends it to `v3`:
- `affectedSymbols`, `affectedCallers`, `publicApiSurfaceTouched`.
- `affectedGeneratedFiles`, `affectedQualityGates`.
- `validationScope` — exact CLI commands to run, derived from rule-
  graph + framework-scanners.
- `riskScore` and `riskReasons` extended with new contributors.

**Detailed design.** Refactor lives in three steps:
1. Move impact logic from `packages/inspector/src/impact-graph.ts` to
   `packages/impact-engine/src/`.
2. Re-base on `@shrkcrft/graph` and `@shrkcrft/rule-graph`.
3. Bump schema `v2 → v3`; keep v2 read-compat in the renderer.

**Rounds.** R69 (extract + re-base on graph), R70 (rule-graph
integration + schema v3), R71 (symbol impact + risk-score upgrade).

**Exit criteria.**
- `shrk impact` payload is a strict superset of today's.
- `shrk impact src/foo.ts` runs in < 50 ms on the SharkCraft monorepo.
- `validationScope` lists the exact commands; agents can execute them
  without further reasoning.
- Snapshot tests cover at least 10 known impact scenarios.

### 3.4 `@shrkcrft/structural-search` — safe AST queries

**Purpose.** A TypeScript-first AST query engine. Lets rules, codemods,
and agents say "find every place that matches *this shape*" and get
typed, capped results. Later: controlled rewrites.

**Scope (in, Wave 4).**
- Pattern DSL — either ts-pattern style or a small custom DSL (decision
  in §6).
- Matchers for: decorators, classes, methods, interfaces, object
  shapes, call expressions, imports, exports, string-literal config
  patterns.
- Reusable patterns registered as `sharkcraft.structural-pattern/v1`
  entries (alongside rules / templates).
- Rule-bound queries: rules can attach a structural pattern and a
  severity; matches become rule violations.
- Preview mode — show match locations, never modify.
- Safe match metadata — file, line, column, span, captured groups.

**Scope (in, Wave 8 — later).**
- Controlled AST rewrite/migration. Plan-first (generates a signed
  plan), preview before apply, same `shrk apply --verify-signature`
  pipeline as other generators.
- Built-in migration recipes for common patterns.

**Scope (out).**
- Semantic / type-aware queries that require `ts.Program`. Stay AST-
  only.
- Cross-file refactoring atomicity. Each file is rewritten
  independently; multi-file invariants are the caller's job.

**Surface.**
```ts
export interface IStructuralSearchApi {
  match(pattern: IStructuralPattern, opts?: ISearchOpts): AsyncIterable<IPatternMatch>;
  matchAll(pattern: IStructuralPattern, opts?: ISearchOpts): Promise<readonly IPatternMatch[]>;
  // Wave 8:
  rewrite(pattern: IStructuralPattern, rewrite: IRewriteRecipe, opts?: IRewriteOpts): Promise<IRewritePlan>;
}
```

**Rounds.**
- R72 (pattern DSL + matcher engine, query-only).
- R73 (rule-bound queries + CLI: `shrk search structural <pattern>`).
- R74 (pattern registry + MCP).
- R75 (pack-contributed patterns).
- Wave 8: R86–R88 add rewrite support.

**Exit criteria.**
- An author can write a pattern that matches all `@Controller(...)`
  decorators with no path parameter.
- A rule can attach that pattern and have it surface in `shrk doctor`.
- Match latency: < 200 ms on the SharkCraft monorepo for a typical
  pattern.

### 3.5 `@shrkcrft/architecture-guard` — semantic architecture

**Purpose.** Architecture enforcement beyond mechanical layer/import
checks. Detects public-API misuse, barrel risks, adapter-into-business-
logic leaks, and validates project-specific architecture contracts.

**Scope (in).**
- Layer / forbidden-import checks (delegating to existing
  `boundaries` for the mechanical layer; this package adds the
  *semantic* layer).
- Circular dependency detection (already in graph; surface here with
  severity + suggested break point).
- Public-API misuse: imports from non-`index.ts` of a sibling package,
  imports from `internal/` paths, imports of `*` (star) re-exports
  across packages.
- Barrel risks: barrels that re-export private symbols, barrels that
  cause cycles, "fat barrels" (> N exports without semantic grouping).
- Adapter / business-logic leaks (via patterns from
  `@shrkcrft/structural-search`): infrastructure modules importing
  domain modules, controllers calling repositories directly, etc.
- Project-specific architecture contracts — a config DSL that lets a
  team say "controllers may only import services, services may only
  import repositories" and have it enforced.
- Violations link to graph nodes, severity, suggested fixes, and
  validation commands.

**Scope (out).**
- Auto-fix in MVP. Suggested fixes are previews; `shrk apply` still
  runs the human-in-the-loop pipeline.
- Domain modelling tools (DDD aggregate detection, bounded context
  validation) — separate package, separate wave.

**Surface.**
```ts
export interface IArchitectureGuard {
  check(opts?: IArchCheckOpts): Promise<IArchReport>;
  // Project-specific contracts:
  loadContract(path: string): Promise<IArchContract>;
  validateContract(contract: IArchContract): Promise<IArchReport>;
}
```

**Contract DSL** (sketch — final form decided in Wave 5):
```ts
defineArchContract({
  layers: [
    { name: 'controllers', includes: ['**/controllers/**'] },
    { name: 'services', includes: ['**/services/**'] },
    { name: 'repositories', includes: ['**/repositories/**'] },
  ],
  rules: [
    { from: 'controllers', mayImport: ['services'], severity: 'error' },
    { from: 'services', mayImport: ['repositories'], severity: 'error' },
    { from: 'controllers', mayNotImport: ['repositories'], severity: 'error' },
  ],
});
```

**Rounds.** R76 (public-API misuse + barrels), R77 (contract DSL +
structural-search integration), R78 (adapter leaks + suggested fixes),
R79 (CLI + MCP + doctor integration).

**Exit criteria.**
- `shrk arch check` reports public-API and barrel violations on the
  SharkCraft monorepo with no false positives on legitimate patterns.
- A team can write an arch contract and have it enforced as a doctor
  check + boundary-style report.

### 3.6 `@shrkcrft/context-planner` — agent context packs

**Purpose.** Given a task and a workspace, produce a compact,
token-budgeted, ranked bundle of "what the agent needs to know first."
Replaces blind file reading with deterministic context selection.

**Scope (in).**
- Intent classification: from a free-text task, pick one of
  `feature`, `bug-fix`, `refactor`, `docs`, `release`, `migration`,
  `unknown`. Drives ranker weights.
- Relevant file set: top-N files ranked by graph proximity to entities
  mentioned in the task + path-pattern matches + bridge edges to
  matching rules/templates.
- Related contracts: which rules, paths, templates, pipelines apply
  to those files.
- Examples: known canonical example for each construct touched.
- Tests: likely test files (via impact-engine).
- Risks: top-N graph cycles, public-API touches, do-not-touch zones.
- Do-not-touch zones: configurable per-workspace + auto-derived
  (generated files, vendored code, `internal/` paths).
- Token budgeting: caller asks for a budget; planner returns the
  best-ranked subset that fits.
- Agent-specific formatters: Claude / Codex / Cursor / generic MCP.

**Scope (out).**
- LLM-driven ranking. Ranking is deterministic and inspectable.
- Multi-turn context evolution. The planner is called once per task
  start; rerun on demand.
- Cross-task context — each call is stateless.

**Surface.**
```ts
export interface IContextPlanner {
  planContext(input: IContextRequest): Promise<IContextPack>;
}

export interface IContextRequest {
  task: string;
  budgetTokens?: number;          // default 8000
  agent?: 'claude' | 'codex' | 'cursor' | 'mcp' | 'generic';
  hints?: { files?: readonly string[]; packages?: readonly string[] };
}

export interface IContextPack {
  schema: 'sharkcraft.context-pack/v1';
  intent: TaskIntent;
  files: readonly IRankedFile[];
  rules: readonly IRuleEdgeHit[];
  examples: readonly IExampleRef[];
  tests: readonly IFileRef[];
  risks: readonly IRiskHit[];
  doNotTouch: readonly string[];
  budget: { requested: number; used: number; truncated: boolean };
}
```

**Rounds.** R80 (intent classifier + ranker), R81 (budgeting +
formatters), R82 (CLI + MCP integration), R83 (doctor / dashboard).

**Exit criteria.**
- Given the same task string on the same repo, two runs return the
  same pack (deterministic).
- Pack output fits the requested budget within a 5 % tolerance.
- A/B test: agent runs with planner context complete tasks faster
  than with `shrk context --task` alone (measure: tool calls per
  task, files opened per task).

### 3.7 `@shrkcrft/framework-scanners` — semantic enrichment

**Purpose.** Add framework-specific nodes and edges to the graph so
the agent can ask "which controller handles route /users", "which
component uses hook X", "what providers does this module declare".

**Scope (in, Wave 7).**
- Plugin contract `IFrameworkExtractor`:
  ```ts
  export interface IFrameworkExtractor {
    name: string;                              // 'nestjs' | 'angular' | 'react' | 'express'
    fileMatches(file: IFileNode): boolean;
    extract(file: IFileNode, ctx: IExtractCtx): Promise<IFrameworkExtraction>;
  }
  ```
- Initial extractors:
  - **NestJS**: modules, controllers, providers, guards, pipes,
    interceptors, DTOs, dependency-injection edges, route → handler
    edges.
  - **Angular**: modules, components, services, directives, pipes,
    templates, DI graph, route declarations.
  - **React**: components (function + class), hooks declared, hooks
    used, props shape, state shape, prop-drilling edges,
    component-call edges.
  - **Express**: routers, route handlers, middleware chains,
    `app.use` topology.
- Framework-tagged nodes: `framework:nestjs:controller`,
  `framework:angular:component`, etc.
- Edges: `handles-route`, `provides-token`, `injects-token`,
  `uses-hook`, `renders-component`.
- Diagnostics for framework-specific anti-patterns surfaced via
  `@shrkcrft/architecture-guard` (e.g. circular DI).

**Scope (in, Wave 9 — later).**
- Fastify, Next.js, Electron, Vue, Svelte.
- Backend adapter scanners (TypeORM, Prisma, Mongoose) — if demand.

**Scope (out).**
- LLM-derived framework detection. Detection is signature-based
  (decorators, imports, file naming).
- Runtime framework state (route tables resolved at runtime, dynamic
  module imports) — best-effort only.

**Surface.** Plugin contract above. Plus a registry:
```ts
export class FrameworkExtractorRegistry {
  register(extractor: IFrameworkExtractor): void;
  list(): readonly IFrameworkExtractor[];
  applicable(file: IFileNode): readonly IFrameworkExtractor[];
}
```

**Rounds.**
- R84 (NestJS extractor + plugin contract + graph integration).
- R85 (Angular extractor).
- R86 (React extractor — overlap with Wave 8 structural-search rewrite).
- R87 (Express extractor).
- Later waves add Fastify, Next.js, Electron, Vue, Svelte one extractor
  per round.

**Exit criteria.**
- `shrk graph search --kind framework:nestjs:controller` returns all
  Nest controllers.
- `get_graph_impact` for a NestJS module change includes affected
  providers, routes, and DI consumers.
- A NestJS app's startup-time route table can be reconstructed from
  the graph (modulo dynamic registration).

## 4. Delivery waves

Eight waves, ~24 rounds total. Each wave ends with a user-visible
artifact and green CI. No wave starts until the previous wave's exit
criteria are met.

| Wave | Rounds | Theme | Deliverable |
|---|---|---|---|
| **1. Foundation** | R63–R65 | `@shrkcrft/graph` MVP | Persistent graph, CLI, MCP; `shrk impact` rewired |
| **2. Bridges + impact** | R66–R71 | `@shrkcrft/rule-graph` + `@shrkcrft/impact-engine` | Bridge edges live; impact schema v3; symbol impact |
| **3. Symbol references** | (inside R69–R71) | Symbol-level edges in graph | `references-symbol`, `calls-symbol`, `extends-symbol`, `implements-symbol`; `shrk graph callers` |
| **4. Structural search** | R72–R75 | `@shrkcrft/structural-search` query-only | Pattern DSL, matcher engine, rule-bound queries |
| **5. Architecture guard** | R76–R79 | `@shrkcrft/architecture-guard` | Public-API + barrel + adapter checks; contract DSL |
| **6. Context planner** | R80–R83 | `@shrkcrft/context-planner` | Compact, deterministic context packs |
| **7. Framework scanners** | R84–R87 | `@shrkcrft/framework-scanners` first four extractors | NestJS, Angular, React, Express |
| **8. Structural rewrite** | R88–R90 | Add rewrite mode to structural-search | Plan-first AST migrations |
| **(later)** | R91+ | Additional frameworks; SQLite if needed; multi-language | Demand-driven |

### Parallelism within a wave

Waves are serial because each depends on the previous wave's
foundation. *Within* a wave, work parallelises:

- Wave 1: schema + store + extractor in parallel with CLI + MCP
  scaffolding; rewire `shrk impact` last.
- Wave 2: `rule-graph` can ship 1–2 rounds before `impact-engine`
  uses it; `impact-engine` extraction can happen in parallel with
  `rule-graph` schema design.
- Wave 7: each framework extractor is independent — they ship in
  whatever order makes sense.

## 5. Cross-cutting concerns

These apply across every package and should be decided once.

### 5.1 Schema versioning

- Each package owns its own schema namespace:
  `sharkcraft.graph/v1`, `sharkcraft.impact-analysis/v3`,
  `sharkcraft.structural-pattern/v1`, `sharkcraft.context-pack/v1`,
  etc.
- Schema bumps require a migration test and a renderer that handles
  the older version for at least one minor release.
- The `meta.json` of each persisted store includes all schema
  versions in use — `shrk doctor` validates compatibility on every
  start.

### 5.2 Store layout

```
.sharkcraft/
  graph/                  # @shrkcrft/graph
    meta.json
    files.json
    nodes/*.jsonl
    edges/*.jsonl
  bridge/                 # @shrkcrft/rule-graph
    meta.json
    edges.jsonl
  impact-cache/           # @shrkcrft/impact-engine
    last-run.json
  patterns/               # @shrkcrft/structural-search
    registry.json
  context-packs/          # @shrkcrft/context-planner
    <task-hash>.json
  framework/              # @shrkcrft/framework-scanners
    <framework>/...
```

Each package's store is independent; nothing reads another package's
files directly. Stores are derived data — `.gitignore`d by default,
opt-in to commit per team policy.

### 5.3 MCP discipline

Every new MCP tool follows the existing safety contract:

- Read-only.
- Returns the same payload as the CLI `--json`.
- When state is missing/stale, returns a structured error with
  `nextCommand: '<exact shrk command to fix>'`.
- Schema-versioned response.

### 5.4 CLI surface

New top-level verbs added to `shrk`:

| Verb | Subcommands | Source package |
|---|---|---|
| `shrk graph` | `index`, `status`, `search`, `context`, `impact`, `why`, `export` | `@shrkcrft/graph` |
| `shrk rules` | `where applies-to <file>` (new), existing subcommands | `@shrkcrft/rule-graph` |
| `shrk impact` | (unchanged, rewired) | `@shrkcrft/impact-engine` |
| `shrk search structural` | `<pattern>`, `--rewrite` (Wave 8) | `@shrkcrft/structural-search` |
| `shrk arch` | `check`, `contract`, `violations` | `@shrkcrft/architecture-guard` |
| `shrk context` | (existing, augmented) | `@shrkcrft/context-planner` |
| `shrk graph framework` | `list`, `show <framework>` | `@shrkcrft/framework-scanners` |

### 5.5 `shrk doctor` integration

Each package contributes one or more doctor checks. Shipped today via
`buildCodeIntelligenceChecks` in
`packages/inspector/src/code-intelligence-doctor.ts`, called from
`runDoctor` and bucketed under `category: 'code-intelligence'` so
`--hide code-intelligence` mutes the whole section:

| Package | Check id | Today | Roadmap remainder |
|---|---|---|---|
| `@shrkcrft/graph` | `code-intelligence-graph` + `-graph-cycles` + `-graph-unresolved` | **shipped** — reads `.sharkcraft/graph/meta.json`; OK on fresh, advisory `Warning` past `staleThresholdDays` (default 7), structural `Warning` on corrupt JSON, `Info` ("no index yet") when missing. Surfaces `files / nodes / edges` plus `cycleCount / largestCycleSize / filesInCycles` (computed at index time by `summarizeCycles` — iterative Tarjan SCC over `imports-file` edges) and `unresolvedImportCount / filesWithUnresolvedImports / unresolvedImportSamples` (rolled up from `unresolved:*` edges by `summarizeUnresolvedImports`). Advisory `-graph-cycles` fires when `largestCycleSize ≥ 3` or `cycleCount ≥ 5`; regular `Warning` `-graph-unresolved` whenever count > 0 with first 3 sample specifiers + DX fix hint. Public API: `GraphQueryApi.cycles()` returns the full SCC list (§3.1) + `shrk graph cycles` CLI prints them. | — |
| `@shrkcrft/rule-graph` | `code-intelligence-rule-graph` + `-rule-coverage` | **shipped** — reads `.sharkcraft/bridge/meta.json`; same freshness model; silent when no bridge has been built. Surfaces bridge node/edge totals. The bridge builder now tracks `filesTotal` / `filesCoveredByRules` / `filesUncoveredByRules` (boundary + knowledge-rule `applies-rule` edges only). Coverage gap surfaces as advisory `Warning` when uncovered ratio > 50%. | — |
| `@shrkcrft/impact-engine` | `code-intelligence-impact` + `-impact-baseline` | **shipped** — reads `.sharkcraft/impact/last.json` (schema `sharkcraft.impact-run/v1`) auto-written by `shrk impact --via-graph`. Regular `Warning` on `risk = high\|critical`; OK on `low\|medium`; advisory downgrade when stale. Backed by `ImpactReportStore` + `snapshotImpactAnalysis`. Symmetric `shrk impact baseline write\|show\|clear` persists a frozen run at `.sharkcraft/impact/baseline.json`; doctor `code-intelligence-impact-baseline` surfaces dependent/package/risk delta vs baseline (`Warning` when worsened, OK within baseline). `--no-persist` opts out of the auto-write. | — |
| `@shrkcrft/structural-search` | `code-intelligence-structural-search` | **shipped** — reads `.sharkcraft/structural/patterns.json` (schema `sharkcraft.structural-pattern-registry/v1`). `Warning` when any registered entry has `lastValidationError`; advisory `Info` for empty registry or for entries that have never been validated; OK when every entry has a fresh `lastValidatedAt`. Backed by `PatternRegistryStore` + CLI `shrk search-structural registry <list\|add\|remove\|validate\|clear>`. Entries can be hand-edited or pack-contributed and the validator catches drift at the boundary. | — |
| `@shrkcrft/architecture-guard` | `code-intelligence-architecture` | **shipped** — reads `.sharkcraft/architecture/{baseline,last}.json`. `Warning` on new violations since baseline (with first 3 sample ids + error/warning delta); `Info` when only one side is present; OK on `delta ≤ 0`. Backed by `shrk arch baseline write\|show\|clear` and automatic `last.json` write on every `shrk arch check`. | — |
| `@shrkcrft/context-planner` | `code-intelligence-context-planner` | **shipped** — reads `.sharkcraft/context-planner/intent-benchmark.json` (schema `sharkcraft.intent-benchmark/v1`) written by `shrk context benchmark`. OK on 100% accuracy; `Warning` on any miss with sample `expected → actual`; `Warning` is advisory while accuracy ≥ 80% and non-advisory below. Backed by `loadIntentBenchmark / runIntentBenchmark / writeBenchmarkRun` in `@shrkcrft/context-planner`. Fixture lives at `sharkcraft/intent-benchmark.json` (author-checked-in), run lives under `.sharkcraft/` (derived). | — |
| `@shrkcrft/framework-scanners` | `code-intelligence-framework` | **shipped** — reads `.sharkcraft/framework/meta.json`. OK on fresh with per-framework breakdown (`nestjs=12, react=47, …`); advisory `Warning` on stale; advisory `Info` when the scan ran but found no entities; structural `Warning` on corrupt JSON. Plus the inline `framework:<name>:<subtype>` counts continue to flow through `IGraphManifest.nodesByKind`. | — |
| `@shrkcrft/api-surface-diff` | `code-intelligence-api-surface` | **shipped** — reads `.sharkcraft/api-surface/signatures.json`; OK on fresh, advisory `Warning` past staleness. Surfaces cached-file count. | — |
| `@shrkcrft/quality-gates` | `code-intelligence-quality-gate` | **shipped** — reads `.sharkcraft/quality-gates/last.json`; OK on `overall=pass`, `Warning` on `overall=fail` (lists failing gate ids + `shrk gate` re-run hint), `Info+advisory` on `warn\|skipped\|unknown`. | — |
| `@shrkcrft/migrate` | `code-intelligence-migrations` | **shipped** — scans `.sharkcraft/migrations/*.state.json`; regular `Warning` on any `overall=fail` checkpoint with `shrk migrate resume <id>` fix (or `prune --include-failed`). | — |
| (cross-store) | `code-intelligence-schema-mismatch` | **shipped** — every read path checks the `schema` field against an inspector-side `EXPECTED_SCHEMAS` table covering graph, bridge, api-surface, quality-gates, framework, architecture baseline/last, impact, and migration state files. Single `Warning` aggregates all mismatches with a regenerate hint. Closes §5.1 promise that doctor validates compatibility on every start. | — |

Design contract: inspector deliberately does **not** depend on any
code-intelligence package — checks read the state files directly with
locally-redeclared minimal JSON shapes, so an uninstalled add-on stays
silent rather than breaking doctor.

### 5.6 Dashboard surfaces

Add panels to `shrk dashboard`:
- **Graph health** — node + edge counts by kind, fingerprint age.
- **Impact heatmap** — top-N files by impact-radius.
- **Architecture violations** — current vs baseline.
- **Pattern matches** — counts per registered pattern.
- **Framework map** — counts per framework, route → controller view.

### 5.7 Docs discipline

For every new package, ship:
- `docs/<package>.md` — public surface + CLI/MCP + examples.
- `docs/<package>-internals.md` — store layout, extractors, schemas.
- An entry in `docs/INDEX.md`.
- A `knowledge` entry referencing the doc, so `shrk knowledge search`
  finds it.

### 5.8 Naming convention

The new packages use the `@shrkcrft/*` scope. The existing packages
remain `@sharkcraft/*`. A rebrand from `@sharkcraft/*` →
`@shrkcrft/*` repo-wide is a separate decision and **does not block
this roadmap** — both scopes can coexist via tsconfig path aliases.

If a rebrand is desired, schedule it as a standalone round between
waves (no functional changes, scoped to package renames + import
updates + dist rebuilds + manifest re-signings).

## 6. Open design questions

Decide each before code starts on the relevant wave.

### Wave 1 (graph)

1. **Re-export collapse.** When `A` re-exports `foo` from `B`, does
   `imports A` resolve to `symbol:B#foo` directly, or stay as a
   re-export edge? *Proposed:* keep the indirection; expose a
   `--resolve-reexports` flag.
2. **Test/spec marking.** Tag or separate node kind? *Proposed:*
   tag.
3. **Generated files.** Same as tests; *proposed:* tag + a
   `generated-from` edge when template known.
4. **Type-only imports.** Same `imports-file` edge with
   `data.typeOnly: true`. Avoids edge-kind explosion.
5. **Index location override.** Support `$SHRKCRFT_GRAPH_DIR` env
   var? *Proposed:* yes, with `.sharkcraft/graph/` as default.

### Wave 2 (rule-graph + impact-engine)

6. **Bridge cardinality limits.** Cap edges per file? Bridge edges
   could explode if naive (a file might match 50 rules). *Proposed:*
   only emit edges where the rule is in `enforced | warned` state;
   `info`-level rules are queryable on-demand only.
7. **Impact-engine cache invalidation.** When does the impact cache
   bust? *Proposed:* hash of (graph fingerprint, rule-graph
   fingerprint, input).

### Wave 4 (structural-search)

8. **Pattern DSL choice.** Custom DSL vs. existing engine
   (ts-pattern, @typescript-eslint/utils, eslint-rule-tester)?
   *Proposed:* prototype both in R72, pick before R73.
9. **Pattern execution sandboxing.** Patterns are code — does the
   engine accept arbitrary JS? *Proposed:* no. Patterns are a
   declarative AST shape; no executable predicates in MVP.

### Wave 5 (architecture-guard)

10. **Contract DSL location.** Where do teams put their
    `arch-contract.ts`? *Proposed:* `sharkcraft/arch.ts` next to
    `boundaries.ts`. Same registration model.

### Wave 6 (context-planner)

11. **Intent classification.** Rule-based or a tiny embedded model?
    *Proposed:* rule-based (keyword + path-pattern). No model
    weights in the engine.
12. **Token counting.** Use which tokenizer? *Proposed:* a small
    deterministic BPE approximation; document the discrepancy with
    real model tokenizers.

### Wave 7 (framework-scanners)

13. **Plugin loading.** First-party only or pack-contributed?
    *Proposed:* both. First-party for NestJS/Angular/React/Express;
    packs can contribute extractors via the existing pack
    contribution mechanism.

## 7. Risks

| Risk | Likelihood | Wave | Mitigation |
|---|---|---|---|
| **Half-finished** — start Wave 1, ship it, never finish later waves | High | 1 | Each wave's exit criteria are user-visible; if a wave stalls > 2 rounds without progress, escalate or de-scope |
| **Schema thrash in graph v1** cascades into every downstream package | High | 1 | Seal `sharkcraft.graph/v1` *before* Wave 2 starts. Breaking changes after that = `v2` + migration |
| **Performance regression** — persistent indexes are slower than on-demand scans for small repos | Medium | 1 | Budget tests in CI; auto-fallback to in-memory mode if index is < 100 files |
| **Pattern DSL bikeshedding** burns weeks in Wave 4 | Medium | 4 | Time-box DSL choice to R72; pick "good enough"; iterate later |
| **Framework extractor sprawl** — Wave 7 never ends | Medium | 7 | Ship four extractors as MVP; stop. Add more only on demand |
| **Context planner ranking** is unverifiable | Medium | 6 | Build a fixed task → expected-files benchmark before R80 |
| **MCP write leak** — a future package accidentally adds write capability | Low | All | Boundary rule blocks MCP from importing any builder/indexer; CI test asserts this |
| **Rebrand drag** — `@sharkcraft/*` → `@shrkcrft/*` mid-roadmap | Medium | Cross | Decide rebrand timing *before* Wave 1, not during |
| **Disk footprint** of stores exceeds team tolerance | Low | All | Document `.sharkcraft/` size budgets; compaction triggers; doctor warns on bloat |
| **SQLite temptation** lands before measured need | Low | 1 | Document the upgrade trigger criteria (cold-start > 300 ms, search > 50 ms, > 50 MB); don't promote earlier |

## 8. Success criteria — what "done" looks like at each wave

| After wave | Agent can… | Latency target |
|---|---|---|
| **1** | Ask "which files import X?", "what's in this package?", "where is `foo` declared?" in one MCP call | < 50 ms |
| **2** | Ask "what does changing this break?" and get rules + templates + tests + owners in one call | < 100 ms |
| **3** | Ask "who calls function `foo`?" — symbol-precise, not text-fallback | < 100 ms |
| **4** | Run a structural search and get all `@Controller()` decorators without no-path argument | < 200 ms |
| **5** | Run `shrk arch check` and get violations with suggested fixes | < 500 ms |
| **6** | Start a task and receive a deterministic, token-budgeted context pack | < 200 ms |
| **7** | Ask "which controller handles GET /users?" or "which components use hook X?" | < 100 ms |
| **8** | Apply a controlled AST migration with preview + signed plan | rewrite plan in < 1 s |

End state: an agent working on a SharkCraft-managed repo makes
**one** context-planner call to start, then 1–3 targeted graph /
impact / arch calls per edit. Today's blind file-reading pattern goes
away.

## 9. Out of scope

Items intentionally **not** on this roadmap:

- IDE / LSP integration. The graph could power one; out of scope for
  the engine.
- Cross-repo intelligence. Single repo at a time.
- Online / SaaS components. Local-first, no network.
- AI inside the engine. Per the SharkCraft safety contract — every
  output is a function of the workspace + the asset registries.
- Visual editor for arch contracts. CLI + config DSL only.
- Multi-language Phase 1. TypeScript-first; other languages slot in
  when demand justifies the extractor work.

## 10. Re-evaluation cadence

After every wave, hold a one-round review:

1. Did we hit the wave's exit criteria?
2. Did the schema stay stable? If not, why?
3. Is the next wave's scope still correct?
4. What did we learn that changes the open questions above?

Update this document at each review. The roadmap is a living plan,
not a contract.
