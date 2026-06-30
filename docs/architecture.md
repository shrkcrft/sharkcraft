# Architecture

## Packages

```
core
  ↓
config / workspace / knowledge / templates
  ↓
rules / paths
  ↓
context / generator / inspector / ai
  ↓
mcp-server / cli
                  ↓
            dashboard-api  ← dashboard  (browser bundle)
```

### Strict dependency direction

- No package may depend on `cli` or `mcp-server` (except `cli` may load `mcp-server` for `shrk mcp serve`).
- No package may contain framework imports.
- Lower layers cannot import higher layers.

### Roles

- `core` — Result, errors, logger, FS, path/string/object utils.
- `config` — `sharkcraft.config.ts` loader + defaults + validation.
- `workspace` — project root, package.json, package manager, frameworks, tsconfig.
- `knowledge` — typed entries, index, search, loaders (TS + markdown), formatting.
- `rules` / `paths` — domain-specific services over the knowledge index.
- `templates` — template definitions, registry, rendering, variable validation.
- `context` — token-budgeted relevance retrieval, AI-ready output.
- `generator` — `GenerationPlan`, `FileChange`, `OverwriteStrategy`, dry-run, safe writes.
- `inspector` — combines workspace + knowledge to provide doctor checks and project overviews.
- `ai` — `IAiProvider` abstraction with a Claude HTTP adapter and a Claude CLI adapter.
- `mcp-server` — MCP server built on `@modelcontextprotocol/sdk` (`Server` + `StdioServerTransport`) with 25 tools, each a thin adapter over the packages above.
- `cli` — `shrk` CLI binary, command registry, output formatting. Hosts the
  local read-only dashboard server (`shrk dashboard`) which serves the
  Vite-built UI plus the same data the MCP server exposes.
- `plugin-api` — Extension points for command/knowledge/template/AI/MCP plugins.
- `dashboard-api` — Versioned contract types for the dashboard wire protocol
  (`sharkcraft.dashboard-api/v1`). No runtime — consumed by both the CLI
  (server-side envelopes) and the browser bundle (typed client).
- `dashboard` — React + Vite browser bundle (`@shrkcrft/dashboard`). 12
  pages, fully read-only, dependency-light. Built via `bun run dashboard:build`.
- `shared` — Reserved minimal cross-package bits.

## CLI vs MCP vs dashboard vs core logic

- **Core logic** lives in domain packages (knowledge, context, generator…).
- **CLI** is the human surface: parsing, output formatting, no business logic.
- **MCP server** is the agent surface: tool schemas, response shaping, no business logic.
- **Dashboard** is the browser surface: a read-only view onto the same data
  the MCP server exposes. The HTTP server lives inside `cli` (so the CLI
  binary is the single binary to ship). The UI types live in `dashboard-api`
  so a future external dashboard can depend on the contract without pulling
  in any engine code.

This guarantees that adding a new feature only touches one core package; CLI,
MCP, and the dashboard get it nearly for free.

## Build outputs

`build:dist` runs per-package `tsc` for every publishable package except
`dashboard`, which is a browser bundle built by Vite via `dashboard:build`.
`release:preflight` runs both. Playwright E2E (`--with-e2e`) is opt-in and
runs against `examples/dashboard-e2e-target`.

## Surfaces (R18–R20)

The architecture is exposed through several read-only surfaces:

```bash
# Layered map + risk + signals
shrk architecture map --risk --signals

# All current boundary violations
shrk architecture violations

# Violations diff (R20): scoped to changed/staged/explicit files, optionally
# compared against a baseline JSON snapshot. Each entry is classified
# existing-touched / new-in-changed-file / resolved / unknown.
shrk architecture violations --since main
shrk architecture violations --staged
shrk architecture violations --files a,b,c --baseline base.json --format markdown

# Members of a logical area (e.g. asset-registries)
shrk architecture area <areaId>
```

### Repository intelligence graph

> The standalone `shrk intelligence` CLI verb was removed. The code graph
> is now queried through `shrk graph` (subverbs: `index`, `status`,
> `search`, `context`, `impact`, `callers`, `cycles`, `unresolved`,
> `deps`, `why`, `export`); the layered architecture map lives under
> `shrk architecture map`. Over MCP, the same graph is read-only via the
> `get_graph_*` tools (`get_graph_search`/`context`/`impact`/`callers`/…)
> and `get_architecture_map`.

```bash
# Code graph (import / depends-on / tests edges, alias-resolved)
shrk graph index
shrk graph deps @shrkcrft/core
shrk graph why <fromId> <toId>

# Layered architecture map + risk + signals
shrk architecture map --risk --signals
```

MCP equivalents: the `get_graph_*` tools (search / context / impact /
callers / path over the packages/files/constructs/templates graph) plus
the architecture surfaces (`get_architecture_constraints`,
`get_architecture_violations`, `get_architecture_map`). All read-only.
