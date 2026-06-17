# SharkCraft (`shrk`) vs CodeGraph — comparison

A focused side-by-side of `shrk`'s code-intelligence layer
(`@shrkcrft/graph` + the six packages around it) against
[`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph).
Goal: be honest about where CodeGraph is ahead.

Sources reviewed:
- CodeGraph: `~/IdeaProjects/codegraph/` (README, CLAUDE.md, `src/`, package.json @ v0.9.2)
- shrk: this repo (`docs/code-intelligence.md`, `docs/roadmap-code-intelligence.md`, `docs/code-intelligence-quick-ref.md`, `packages/graph/`, sibling packages)

---

## TL;DR

| | CodeGraph | shrk |
|---|---|---|
| **What it is** | A dedicated, language-broad code knowledge graph for AI agents | A deterministic agent toolkit where the code graph is **one** of several layers (rules, templates, generator, safety contract, …) |
| **Scope** | Narrow + deep on code intelligence | Wide — code graph + rule-graph + impact + context planner + architecture guard + framework scanners + the existing asset registries |
| **Production polish** | High — bundled runtime, installer for 5 agents, real benchmarks | Lower on the *code intelligence* axis; high on the asset-registry axis |
| **Languages** | 19+ via tree-sitter | TypeScript / JavaScript only |
| **Store** | SQLite + FTS5 (WAL mode), `better-sqlite3` with `node-sqlite3-wasm` fallback | JSONL on disk (by design; SQLite is documented as a future upgrade trigger) |
| **Freshness** | Native file watcher (FSEvents / inotify / RDCW), 2-second debounce, auto-sync | Explicit `shrk graph index --changed` / `--since <ref>`; daemon is an explicit non-goal |
| **Distribution** | One-line installer bundles Node + auto-wires Claude Code / Cursor / Codex / opencode / Hermes | `bun install` + `shrk install` (Bun-first), no multi-agent installer |

If the question is **"who has the better code knowledge graph today?"** —
CodeGraph. If the question is **"who has the better *agent toolkit*?"** — different
question, different answer (see §5).

---

## 1. What CodeGraph does better

These are the gaps where CodeGraph is materially ahead of `@shrkcrft/graph`
right now, not at the roadmap level.

### 1.1 Language coverage

CodeGraph ships extractors for **19+ languages** via tree-sitter:
TypeScript, JavaScript, Python, Go, Rust, Java, C#, PHP, Ruby, C, C++, Swift,
Kotlin, Scala, Dart, Lua, Luau, Svelte, Vue, Liquid, Pascal/Delphi.

shrk is TypeScript-first by design. `docs/code-intelligence.md` §15 lists
multi-language as Phase 4 ("only if demand"). For any polyglot repo, CodeGraph
is the only option of the two.

### 1.2 Storage and search

- **SQLite with FTS5** for full-text search across symbols and bodies; WAL
  mode so reads never block writes.
- Native `better-sqlite3` when available, transparent `node-sqlite3-wasm`
  fallback. `codegraph status` surfaces which backend is live.

shrk uses **JSONL per node/edge kind** under `.sharkcraft/graph/`. The design
doc is explicit that this is intentional ("JSONL until measured insufficient",
`code-intelligence.md` §6.2) and documents the SQLite upgrade triggers
(cold-start > 300 ms, search > 50 ms, > 50 MB on disk). Today, however,
CodeGraph has the better store for any non-trivial repo size.

### 1.3 Symbol-level edges in MVP

CodeGraph's tree-sitter extractors emit `calls`, `references`, `extends`,
`implements`, `instantiates`, `overrides`, `decorates` edges from day one,
plus a separate `ReferenceResolver` pass that wires up imports, name matches,
and framework-specific patterns.

shrk records declarations + re-exports in Wave 1; symbol references and
`calls-symbol` shipped "light" via Wave 3 (per the status table in
`docs/roadmap-code-intelligence.md`). It works, but it's newer and narrower.

### 1.4 File watcher / freshness

CodeGraph watches the project with **native OS events** (FSEvents on macOS,
inotify on Linux, ReadDirectoryChangesW on Windows), 2-second debounce, source
files only — zero config. The graph stays fresh as you code.

shrk's design explicitly defers a watcher to Phase 5 and only "if demand"
(`code-intelligence.md` §15). Today you run `shrk graph index --changed`
manually or auto-trigger on certain reads (10-minute staleness threshold).
In an interactive agent loop, the CodeGraph experience is materially nicer.

### 1.5 Framework-aware **routes** baked into the graph

CodeGraph emits `route` nodes linked by `references` edges to handler
functions/classes for **14 framework families**:

> Django, Flask, FastAPI, Express, NestJS (REST + GraphQL + microservice +
> WebSocket), Laravel, Drupal (incl. `*.routing.yml` + hooks), Rails, Spring,
> Gin/chi/gorilla/mux, Axum/actix/Rocket, ASP.NET, Vapor, React Router,
> SvelteKit, Vue/Nuxt.

shrk's `@shrkcrft/framework-scanners` ships **NestJS + React** per the
quick-ref. The roadmap (R84–R87) calls for Angular and Express next; Vue,
Svelte, Next.js, Electron, Fastify are "later waves". For "which controller
handles `GET /users`?" across a polyglot repo, CodeGraph is years ahead.

### 1.6 Distribution and multi-agent install

```bash
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
```

- Bundles a per-platform Node runtime — no Node required on the host.
- Interactive installer auto-detects Claude Code, Cursor, Codex CLI,
  opencode, Hermes Agent and writes MCP config + an instructions file
  (`CLAUDE.md`, `.cursor/rules/codegraph.mdc`, `~/.codex/AGENTS.md`,
  `~/.config/opencode/AGENTS.md`).
- Non-interactive flags exist for CI (`--target`, `--location`, `--yes`,
  `--print-config`).
- ~47 parameterized contract tests cover install idempotency, sibling
  preservation, byte-equal re-runs, partial-state recovery.

shrk ships as `@shrkcrft/*` npm packages plus a `shrk` CLI. No comparable
multi-agent installer — adding Cursor / Codex / opencode wiring is on the user.

### 1.7 Published benchmarks

CodeGraph publishes a head-to-head benchmark across 7 real OSS codebases
(VS Code, Excalidraw, Django, Tokio, OkHttp, Gin, Alamofire) showing
**35% cheaper, 59% fewer tokens, 49% faster, 70% fewer tool calls** at the
median of 4 runs. Methodology + raw medians are in the README.

shrk has internal latency budgets (in `docs/code-intelligence-quick-ref.md`
§Performance budgets — e.g. `shrk graph context` ~10 ms vs the < 50 ms
target) but no comparable A/B against "no shrk". The shrk roadmap calls for
this in Wave 6 ("A/B test… tool calls per task, files opened per task") but
it hasn't been run.

### 1.8 Library / embed surface

CodeGraph exports a `CodeGraph` class (`src/index.ts`) with `init`/`open`,
`indexAll`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`,
`buildContext`, `watch`/`unwatch`. Anyone can embed it.

shrk's surface is the `shrk` CLI and the MCP server. Programmatic
consumption means depending on `@shrkcrft/graph` directly, which works but
isn't the documented contract.

### 1.9 Parser strategy

CodeGraph uses tree-sitter with WASM grammars + a `parse-worker.ts` worker
pool. Robust across malformed files, consistent across languages.

shrk uses `ts.createSourceFile` per file (re-using `buildSymbolIndex` from
`@shrkcrft/inspector`). This is deliberate (`code-intelligence.md` §7) —
single-file mode does 1k–5k files/sec and avoids the type-checker cost — but
it's TS-only and doesn't gracefully handle other languages.

---

## 2. What shrk does better

These are not "code graph" wins per se — they're the layers shrk has built
**around** the code graph that CodeGraph doesn't have because it isn't an
opinionated agent framework.

### 2.1 Asset-registry bridges (`@shrkcrft/rule-graph`)

shrk connects code nodes to its existing asset layer — rules, paths,
templates, pipelines, presets, packs, boundaries, knowledge, ownership,
quality gates — via bridge edges. One MCP call (`get_rules_for_file`)
returns every rule, path convention, and template that applies to a given
file.

CodeGraph has no equivalent because rules/templates/pipelines aren't part of
its domain.

### 2.2 Impact analysis with **risk + validation scope**

`shrk graph impact --full` (and `get_graph_impact_analysis`) returns a v3
payload that includes:

- direct + transitive dependents,
- affected symbols,
- **affected rules, templates, generated files, quality gates,**
- likely tests (via co-location, naming, and bridge edges),
- `publicApiTouched` boundary flag,
- `risk: low | medium | high | critical` with `riskReasons`,
- `validationScope` — exact `shrk …` commands to run before/after.

CodeGraph's `codegraph_impact` returns the call-graph reachability radius.
Useful, but it's pure code reachability — no risk model, no test mapping,
no validation command list. The shrk payload is much richer for "should I
make this change?" decisions.

### 2.3 Architecture guard with contract DSL

`shrk arch check` runs deterministic semantic checks beyond mechanical
imports: public-API misuse (deep imports past `index.ts`), fat barrels,
adapter-into-domain leaks, cycle severity. Teams can write a
project-specific contract:

```ts
defineArchContract({
  layers: [
    { name: 'controllers', includes: ['src/**/*.controller.ts'] },
    { name: 'services',    includes: ['src/**/*.service.ts']    },
    { name: 'repos',       includes: ['src/**/*.repository.ts'] },
  ],
  rules: [
    { from: 'controllers', mayImport: ['services'] },
    { from: 'controllers', mayNotImport: ['repos'], severity: 'error' },
  ],
});
```

CodeGraph has no architecture-validation surface. The graph carries enough
information to *build* one, but it isn't shipped.

### 2.4 Context planner (`shrk plan-context`)

Deterministic, token-budgeted context pack for a free-text task:

- Intent classification (feature / bug-fix / refactor / docs / release / migration).
- Ranked files with reasons.
- Applicable rules / paths / templates.
- Likely tests, risks, do-not-touch zones.
- Caller specifies token budget; planner returns the best-fit subset.
- Agent-specific formatters (Claude / Codex / Cursor / generic).

CodeGraph's `codegraph_context` is closer to "give me the full source of the
files relevant to this string." Powerful, but it's about *fetching* code, not
about *planning* what an agent should look at first within a budget.

### 2.5 Safety / signing contract

shrk wraps the whole engine in a safety contract: MCP never writes, apply
requires `--verify-signature` for signed plans, pack-contributed commands
are never auto-run, `shrk onboard --write-drafts` writes only under
`sharkcraft/onboarding/`. The code graph is one piece of a larger
deterministic, auditable pipeline.

CodeGraph is read-only by design, but it doesn't surround a generator /
apply pipeline — it isn't trying to.

### 2.6 Schema versioning and `doctor` / dashboard integration

Every shrk payload self-describes via a `schema` field
(`sharkcraft.graph/v1`, `sharkcraft.graph-impact-analysis/v3`,
`sharkcraft.context-pack/v1`, …). `shrk doctor` validates schema
compatibility, bridge coverage gaps, unresolved imports, cycle deltas.
`shrk dashboard` has panels for graph health, impact heatmap, architecture
violations, framework map.

CodeGraph has `codegraph status`. That's it.

### 2.7 Structural search as a registered, packageable asset

`shrk search-structural` patterns are declarative JSON
(`sharkcraft.structural-pattern/v1`) registered alongside rules and
templates. Packs can ship patterns. The DSL is intentionally non-executable
(no arbitrary JS predicates) — a deliberate sandboxing choice.

CodeGraph's search is FTS5 over symbol names + paths. Excellent for
"find by name"; not equivalent to "find every place that matches this AST
shape."

---

## 3. Head-to-head matrix

| Capability | CodeGraph | shrk |
|---|---|---|
| TypeScript / JavaScript indexing | Yes (tree-sitter) | Yes (`ts.createSourceFile`) |
| Other languages | 17+ via tree-sitter | TS-only |
| Symbol-level call / reference edges | Yes (MVP) | Yes (Wave 3, "light") |
| Persistent store | SQLite + FTS5 (WAL) | JSONL per kind |
| Cold-start latency on large repos | Faster (SQLite indexes) | Documented < 3 s budget on ~1500 files; will need SQLite later |
| File watcher / auto-sync | Native OS events, debounced | Manual; explicit non-goal in MVP |
| Web-framework route extraction | 14 framework families | NestJS + React only |
| Tsconfig path aliases | Yes | Yes |
| Cargo / pnpm / Nx workspace resolution | Cargo workspaces, generic workspaces | Nx + workspaces |
| Pluggable extractors | First-party only | Plugin contract (`IFrameworkExtractor`); first-party + pack-contributed (roadmap) |
| MCP server | Yes (read-only) | Yes (read-only) |
| Multi-agent installer | Claude / Cursor / Codex / opencode / Hermes | None |
| Bundled runtime, single binary | Yes | No (Bun + npm) |
| Public benchmark vs no-tool baseline | Yes (7 repos) | No (planned) |
| Asset-registry bridges (rules, templates, …) | No | Yes |
| Impact risk score + validation commands | No (radius only) | Yes (v3 payload) |
| Architecture-contract DSL | No | Yes |
| Token-budgeted context pack with intent classifier | No (raw context build) | Yes |
| Structural search DSL + pattern registry | No (FTS5 search by name) | Yes |
| Signed apply / generator pipeline | N/A (not in scope) | Yes |
| Doctor / dashboard integration | `codegraph status` | doctor + dashboard panels |
| Library API for embedding | Yes (`CodeGraph` class) | Indirect (depend on package) |

---

## 4. Which is "better"?

They're not the same product. Stating it bluntly:

- **For raw code intelligence** (build a graph, ask it questions, watch
  files, span polyglot repos), **CodeGraph is currently better** on
  almost every axis where you can compare them directly: more languages,
  better store, native watcher, much wider framework-route coverage,
  shipped benchmarks, smoother distribution.
- **For agent-toolkit semantics** (what rule applies here? what template
  generated this file? what's the risk score of this change? what
  commands should I run after?), **shrk is the only option of the two** —
  CodeGraph doesn't model rules, templates, generators, policies, or
  ownership at all.

The honest read of the shrk roadmap (`docs/roadmap-code-intelligence.md`)
is that Waves 1–7 are deliberately reinventing pieces of what CodeGraph
already ships, on top of shrk's existing asset layer. Where CodeGraph
won on raw code intelligence, shrk decided to ship JSONL-first and
explicit-reindex-first to keep the install footprint and dependency
surface tight. Those tradeoffs are defensible — and they leave room to
adopt SQLite + a watcher later, both of which are explicitly documented
as upgrade triggers, not no-gos.

---

## 5. What shrk could borrow from CodeGraph

In rough priority order (highest leverage first):

1. **Tree-sitter as the extractor backbone**, at least as an opt-in
   second extractor for non-TS files. Reuses CodeGraph's grammar choices
   and unlocks Phase 4 (`docs/code-intelligence.md` §15) without writing
   per-language ASTs.
2. **Native file watcher** with debounced auto-sync. The 10-minute
   staleness threshold + manual `--changed` is a worse agent experience
   than "edit a file, query 200 ms later, get fresh results." Already
   documented as Phase 5 — promote it.
3. **SQLite + FTS5** ahead of the documented upgrade triggers. The
   triggers (< 300 ms cold-start, < 50 ms search, < 50 MB) are reasonable
   for SharkCraft itself but tight for any consumer repo. Tree-sitter +
   SQLite is the same engineering bet CodeGraph already validated.
4. **Multi-agent installer**. shrk already wires Claude Code; the
   `targets/registry.ts` pattern from CodeGraph generalises cleanly to
   Cursor / Codex / opencode and would broaden shrk's reachable user
   base substantially.
5. **Published benchmark.** Wave 6 of the roadmap calls for an A/B
   benchmark of context-planner vs blind file-reading. CodeGraph's
   methodology (`claude -p` headless, fixed query, 4 runs/median,
   `total_cost_usd`) is a working template — copy it.
6. **First-class web-framework route nodes.** shrk plans NestJS, Angular,
   React, Express in Wave 7. CodeGraph's coverage (Django, Flask, FastAPI,
   Laravel, Rails, Spring, Gin, Axum, ASP.NET, Vapor, SvelteKit, Nuxt,
   etc.) shows the breadth that pays off — schedule them, even if behind
   the first four.
7. **Library / embed surface.** Document `@shrkcrft/graph` as a first-class
   consumable, not just an internal package.

---

## 6. What CodeGraph could borrow from shrk

For completeness, the other direction:

1. **Rule / template / policy bridges.** CodeGraph stops at "what's in
   the code." Linking code to project conventions (rules, ownership,
   quality gates) is where agent decision-making improves further.
2. **Risk-scored impact analysis.** Reachability is half the answer;
   "high risk because this touches a public API and has no co-located
   test" is the other half.
3. **Token-budgeted context pack.** `codegraph_context` returns a lot of
   source code; a planner that *ranks and trims to budget* is a stronger
   primary entry point for an agent.
4. **Structural search DSL.** FTS5 catches names; an AST-shape DSL
   catches patterns (e.g. "all `@Controller()` with no path arg") that
   FTS5 can't express.
5. **Schema versioning everywhere.** Each payload self-describing via
   a `schema` field makes long-term migration much cheaper.

---

## 7. Bottom line

CodeGraph is the better **code knowledge graph** today — broader languages,
better store, real-time freshness, more framework awareness, smoother
install, published wins. Anyone who needs "a graph for agents to query" and
doesn't need shrk's asset layer should use CodeGraph.

shrk is the better **agent toolkit** — it's solving a bigger problem
(deterministic generation + safety contract + asset registries + signed
apply pipeline) and the code graph is a recent addition (R63+) inside that
larger frame. shrk's graph layer has obvious places to catch up; the
roadmap already names most of them.

The two could comfortably coexist in one repo: CodeGraph as the code-side
index, shrk wrapping it with the bridges, impact engine, context planner,
and apply pipeline. That isn't a recommendation — just a note that the
overlap is smaller than it first appears.
