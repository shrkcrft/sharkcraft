# SharkCraft Overview

SharkCraft is a **universal, AI-ready, retrieval-oriented, Bun-native** developer intelligence system.

## What it is

A toolkit that turns any code repository into a precision context source for
humans (via the `shrk` CLI), AI agents (via MCP tools), and an operator
(via a local read-only **dashboard**). All three surfaces speak to the same
deterministic engine — the CLI is the only write path.

## What it isn't

- It is **not** a documentation reader.
- It is **not** a markdown dumper.
- It is **not** tied to any framework.
- It is **not** Node-first.

## Core artifacts in a target repo

```
sharkcraft/
  sharkcraft.config.ts
  knowledge.ts        # or knowledge/index.ts
  rules.ts
  paths.ts
  templates.ts
  docs/               # optional markdown
  tasks/              # optional roadmap/backlog
```

Each file is **structured TypeScript** (typed entries) so retrieval is precise. Markdown is allowed as supplementary depth.

## Mental model

| Layer | What it does | Owned by |
|---|---|---|
| Structured knowledge | Source of truth (typed entries) | `@shrkcrft/knowledge` |
| Context builder | Precise AI output | `@shrkcrft/context` |
| Rules / paths / templates services | Domain-specific retrieval | `@shrkcrft/rules`, `paths`, `templates` |
| Generator | Plan-first code generation | `@shrkcrft/generator` |
| Workspace + inspector | Project detection + doctor checks | `@shrkcrft/workspace`, `inspector` |
| CLI (`shrk`) | Human surface | `@shrkcrft/cli` |
| MCP server | Agent surface | `@shrkcrft/mcp-server` |
| Dashboard API contract | Versioned wire types (`sharkcraft.dashboard-api/v1`) | `@shrkcrft/dashboard-api` |
| Dashboard UI | Read-only React/Vite browser bundle | `@shrkcrft/dashboard` |

## Where to start

- **First time?** Run `shrk start-here` and read [`docs/start-here.md`](start-here.md).
- **"Which entrypoint should I use?"** — read [`docs/command-entrypoints.md`](command-entrypoints.md) (R41). Programmatic: `shrk commands entrypoints` (R38) plus `shrk explain <cmd>` (R46 — replaces the older `shrk commands surface | machine | legacy | overlaps | explain` matrix). Banners on `shrk recommend`, `shrk context`, `shrk task`, and `shrk search` point operators back at the canonical entrypoint.
- **Schema versions** — `shrk schemas inventory` (R39). See [`docs/schemas-inventory.md`](schemas-inventory.md).
- **Explain one directory** — `shrk explore <path>` (R39). See [`docs/explore.md`](explore.md).
- **What should I re-validate?** — `shrk changes acceptance-replay` (R39). See [`docs/acceptance-replay.md`](acceptance-replay.md).
- **How big is this repo?** — `shrk stats` (R59). See [`docs/repository-stats.md`](repository-stats.md). Available as the **Statistics** dashboard page and the `get_repository_stats` MCP tool.
- **Open the dashboard** — `shrk dashboard` (R59). See [`docs/dashboard.md`](dashboard.md).
- **Cut the tokens an agent reads** — `shrk compress` / `shrk expand`, the `compress_context` + `retrieve_original` MCP tools, and `get_knowledge_graph format:"table"`. Deterministic, reversible (CCR), no model in the loop. See [`docs/compression.md`](compression.md).
