# Code intelligence quick reference

A one-page tour of every CLI verb, MCP tool, and schema that ships in
the SharkCraft code-intelligence layer. Each section is a "when X, do
Y" — pick the smallest tool that answers your question.

> Wave-by-wave status lives in
> [`roadmap-code-intelligence.md`](roadmap-code-intelligence.md). The
> original design lives in
> [`code-intelligence.md`](code-intelligence.md).

## Setup (one-time)

```bash
shrk graph index           # build the persistent code graph (~1s/1500 files)
shrk rule-graph index      # bridge files ↔ rules / paths / templates (~50ms)
shrk framework index       # detect NestJS / React entities (~200ms)
```

Re-run only the first one routinely; the other two are bridges over
the graph and are cheap to rebuild after any code change.

## "Where is X defined?"

```bash
shrk graph search <name>           # symbol / file / package by name
shrk graph search <name> --kind symbol
shrk graph search <name> --kind file
```

MCP: `get_graph_search`

## "What does this file do — give me the full picture"

```bash
shrk graph context <file-or-symbol>
```

Returns:
- declared symbols (Wave 1)
- imports from / imported by (Wave 1)
- applicable rules + path conventions + covering templates (Wave 2, auto-included)
- framework entities living in the file (Wave 7, auto-included)

Flags: `--no-bridge`, `--no-framework` to opt out of enrichment.

MCP: `get_graph_context`

## "Who calls / references this symbol?"

```bash
shrk graph callers <symbol>             # callers via calls-symbol edges
shrk graph callers <symbol> --mode reference   # any reference (includes calls)
```

MCP: `get_graph_callers`

## "Is code A actually wired to code B?"

```bash
shrk graph path <from> <to>          # shortest import/call/implements path A → B
shrk graph path <from> <to> --json   # hops with edge kind + call-site line
```

Each endpoint is a file path or a symbol name. The output lists every hop with
its edge kind (`imports-file`, `calls-symbol`, `implements-symbol`, …) and the
call-site line, so you see HOW they are wired — not just that they are. If
`A → B` has no path it reports whether `B → A` is wired (the dependency runs the
other way), and an honest "no path within N hops, explored M nodes" otherwise.
This is the deterministic answer to "is X wired to Y" that grep cannot give.

MCP: `get_graph_path`

## "What does changing this break?"

```bash
shrk graph impact <file-or-symbol>            # basic dependent closure
shrk graph impact <file-or-symbol> --full     # v3 analysis: + symbols + rules + tests + risk
shrk impact <file>                            # legacy v2 inspector-backed report
```

`--full` returns: directDependents, transitiveDependents,
affectedSymbols, affectedCallerFiles, affectedRules, affectedTemplates,
likelyTests, publicApiTouched, risk (`low | medium | high | critical`)
+ riskReasons + validationScope (`shrk …` commands to run).

MCP: `get_graph_impact_analysis` (the rich v3 payload).

## "What's the load-bearing code (change carefully / understand first)?"

```bash
shrk graph hubs                          # most-referenced symbols + most-imported files (repo-wide)
shrk graph hubs --path packages/foo      # scope to one subsystem (onboarding to an area)
shrk graph hubs --limit 25 --json
```

The companion to `impact`: impact = the blast radius of ONE node; hubs = the
nodes with the BIGGEST blast radius. In-degree counts DISTINCT dependent files,
so the rank reflects blast radius, not call volume.

MCP: `get_graph_hubs`

## "Give me the right context to start this task"

```bash
shrk plan-context "rewire the impact engine to use the bridge"
shrk plan-context "fix the broken alpha bug" --budget 4000 --max-files 10
shrk plan-context "..." --hint-file path/to/file --hint-package packages/foo
```

Returns a deterministic, token-budgeted `IContextPack`:
- intent (feature / bug-fix / refactor / docs / release / migration / unknown)
- ranked files with reasons
- applicable rules / paths / templates
- likely tests
- surfaced risks
- do-not-touch zones
- token budget summary

MCP: `get_context_pack`

## "What's wrong with my architecture?"

```bash
shrk arch check                                 # generic checks (public-API, barrels, cycles, adapter leaks)
shrk arch check --contract sharkcraft/arch.ts   # add a project-specific contract
shrk arch check --no-cycles --no-barrels        # disable specific checks
```

Defines its own contract DSL:

```ts
// sharkcraft/arch.ts
import { defineArchContract } from '@shrkcrft/architecture-guard';
export default defineArchContract({
  id: 'my-app.layers',
  layers: [
    { name: 'controllers', includes: ['src/**/*.controller.ts'] },
    { name: 'services',    includes: ['src/**/*.service.ts']    },
    { name: 'repos',       includes: ['src/**/*.repository.ts'] },
  ],
  rules: [
    { from: 'controllers', mayImport: ['services'] },
    { from: 'services',    mayImport: ['repos'] },
    { from: 'controllers', mayNotImport: ['repos'], severity: 'error',
      reason: 'controllers go through services for auth + transaction boundaries' },
  ],
});
```

MCP: `get_arch_violations`

## "Find every place that looks like X"

```bash
shrk search-structural --pattern '{"kind":"CallExpression","callee":{"kind":"Identifier","name":"console.log"}}'
shrk search-structural --pattern-file my-pattern.json
```

Pattern kinds (Wave 4 foundation): `CallExpression`, `NewExpression`,
`ImportDeclaration`, `ClassDeclaration`, `Decorator`, `Identifier`,
`StringLiteral`. Each pattern is a declarative JSON shape — no
executable predicates, so packs can ship patterns the same way they
ship templates.

MCP: `get_structural_search`

## "What framework entities are in this app?"

```bash
shrk framework list --framework nestjs --subtype controller
shrk framework list --framework react --subtype component
shrk framework list --file packages/api/src/users.controller.ts
shrk framework routes                # NestJS route table (method, path, handler, file)
```

MCP: `get_framework_entities` (with optional `routes: true`).

## CLI surface in one table

| Verb | What it answers |
|---|---|
| `shrk graph index` | (re)build the code graph |
| `shrk graph index --changed` | incremental update from mtime + content hash |
| `shrk graph index --since <gitref>` | incremental from `git diff` |
| `shrk graph status` | graph health |
| `shrk graph search <name>` | find files / symbols / packages by name |
| `shrk graph context <id>` | one-stop file/symbol view (+ bridge + framework auto-enriched) |
| `shrk graph callers <symbol>` | who calls / references a symbol |
| `shrk graph path <from> <to>` | is code A wired to code B? shortest import/call/implements path |
| `shrk graph impact <id>` | reverse dependent closure |
| `shrk graph impact <id> --full` | full v3 analysis (symbols + bridge + tests + risk) |
| `shrk graph hubs` | most-depended-on symbols/files (load-bearing code) |
| `shrk graph why <a> <b>` | shortest path between two nodes (knowledge graph) |
| `shrk rule-graph index` | build bridge nodes/edges |
| `shrk rule-graph status` | bridge health |
| `shrk rule-graph for <file>` | rules + paths + templates applying to file |
| `shrk search-structural --pattern …` | AST shape search |
| `shrk plan-context "<task>"` | token-budgeted context pack |
| `shrk arch check` | semantic architecture checks |
| `shrk framework index` | run framework-aware extractors |
| `shrk framework list` | enumerate framework entities |
| `shrk framework routes` | NestJS route table |

## MCP tools in one table

All read-only. Missing-state errors carry `details.nextCommand`
pointing at the CLI verb that builds the missing state.

| Tool | Backed by | Returns |
|---|---|---|
| `get_graph_status` | code graph | health + counts |
| `get_graph_search` | code graph | file / symbol / package matches |
| `get_graph_context` | code graph | neighbours + symbols + subtypes/supertypes |
| `get_graph_callers` | code graph | callers / references of a symbol |
| `get_graph_path` | code graph | is A wired to B? shortest import/call/implements path |
| `get_graph_impact` | code graph | basic reverse closure |
| `get_graph_hubs` | code graph | most-depended-on symbols/files (load-bearing code) |
| `get_graph_impact_analysis` | impact-engine | v3 payload (symbols + bridge + tests + risk) |
| `get_rules_for_file` | rule-graph | rules + paths + templates for one file |
| `get_structural_search` | structural-search | declarative AST pattern matches |
| `get_context_pack` | context-planner | ranked, token-budgeted file set |
| `get_arch_violations` | architecture-guard | semantic violations + suggested fixes |
| `get_framework_entities` | framework-scanners | NestJS / React entities + route table |

## Schemas

Every payload self-describes via a `schema` field:

| Schema | Producer |
|---|---|
| `sharkcraft.graph/v1` | graph store + manifest |
| `sharkcraft.graph-search/v1` | `get_graph_search` |
| `sharkcraft.graph-context/v1` | `get_graph_context` (+ bridge + framework subobjects) |
| `sharkcraft.graph-impact/v1` | `get_graph_impact` (basic) |
| `sharkcraft.graph-impact-analysis/v3` | `get_graph_impact_analysis` (full) |
| `sharkcraft.graph-callers/v1` | `get_graph_callers` |
| `sharkcraft.rule-graph/v1` | bridge store + manifest |
| `sharkcraft.rule-graph-for-file/v1` | `get_rules_for_file` |
| `sharkcraft.structural-pattern/v1` | input shape for `search-structural` |
| `sharkcraft.structural-search/v1` | structural-search result |
| `sharkcraft.context-pack/v1` | context-planner |
| `sharkcraft.architecture-report/v1` | architecture-guard |
| `sharkcraft.arch-contract/v1` | `defineArchContract` |
| `sharkcraft.framework/v1` | framework store + manifest |
| `sharkcraft.framework-list/v1` | `get_framework_entities` listing |
| `sharkcraft.framework-routes/v1` | NestJS route table |

## Decision tree — which tool do I want?

```
I want to …                          → use
─────────────────────────────────────┴────────────────────────
… start a task with the right files  → shrk plan-context
… understand one file in depth       → shrk graph context
… find a symbol / file / package     → shrk graph search
… see who calls / uses a symbol      → shrk graph callers
… estimate change blast radius       → shrk graph impact --full
… check what rules apply to a file   → shrk rule-graph for <file>
… find structural anti-patterns      → shrk search-structural
… check architecture invariants      → shrk arch check
… enumerate framework entities       → shrk framework list / routes
… see the shortest path in the asset graph → shrk graph why <a> <b>
```

## Anti-patterns to avoid

- **Calling these tools without an index built.** Every read tool
  returns `nextCommand` when its backing store is missing — but
  re-running once per session is faster than a paged error.
- **Treating `shrk graph impact` and `shrk impact` as interchangeable.**
  The former is graph-backed and fast; the latter is the legacy
  inspector-backed report with richer prose. The two will converge in
  a future round; for now, use `shrk graph impact --full` for the
  agent path.
- **Skipping `shrk arch check` before a refactor.** The barrel-fat /
  cycle / adapter-leak findings are deterministic — they're as much
  signal as `tsc`.
- **Hand-crafting context for agents.** `shrk plan-context` is
  deterministic and replayable; an agent that builds its own context
  by grepping will produce inconsistent runs.

## Performance budgets

| Operation | Target | Live on SharkCraft monorepo |
|---|---|---|
| `shrk graph index` (full, ~1500 files) | < 3 s | ~1.5 s |
| `shrk graph index --changed` (clean) | < 100 ms | ~60 ms |
| `shrk graph context <file>` | < 50 ms | ~10 ms |
| `shrk graph impact <file> --full` | < 100 ms | ~30 ms |
| `shrk plan-context "..."` | < 200 ms | ~50 ms |
| `shrk arch check` | < 500 ms | ~150 ms |
| `shrk framework index` (~1500 files) | < 1 s | ~200 ms |
| `shrk search-structural` (typical) | < 200 ms | < 1 s on broad patterns |

All numbers are deterministic — same repo, same input → same output.
