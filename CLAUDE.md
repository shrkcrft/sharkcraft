# CLAUDE.md

This file briefs Claude Code (and any agent that loads `CLAUDE.md`) on the
SharkCraft repository. Keep it short; deep details live in `docs/` and behind
the `shrk` CLI.

---

## What this repo is

SharkCraft is a deterministic, local-first toolkit that gives AI coding agents
durable project context. It ships as:

- A CLI (`shrk`) — the only write path.
- An MCP server — read-only by design.
- A library of structured assets (knowledge, rules, paths, templates,
  pipelines, presets, boundaries) that the CLI/MCP both consume.

**No AI inside the engine.** Every output is a function of the workspace +
the asset registries. The agent uses the engine; the engine never calls a
model.

---

## Repo layout

Nx-style monorepo. Each package is `packages/<name>` and publishes from
`packages/<name>/dist`.

```
packages/
  core/         shared types, errors, results, IDs
  workspace/    package.json / framework / profile detectors
  config/       sharkcraft.config.ts loader (zod-validated)
  knowledge/    knowledge entry model + loaders (TS / Markdown)
  rules/ paths/ templates/ pipelines/ presets/ boundaries/
                domain registries + recommenders
  packs/        pack discovery + signed-manifest verifier
  generator/    plan → review → apply pipeline + HMAC plan signing
  importer/     AGENTS.md / CLAUDE.md / .cursor/rules parsers
  inspector/    aggregate inspection + doctor + task packet +
                ranker + readiness + onboarding inference
  mcp-server/   read-only MCP tools (no writes, ever)
  cli/          the `shrk` command surface
  ai/           thin context-formatting helpers
  plugin-api/   pack contract types
  shared/       tiny shared utilities
examples/
  unconfigured-bun-service/  dogfood target for `shrk onboard`
  dogfood-target/            integration-test target for everything else
docs/           authoritative guides (overview / philosophy / per-feature)
scripts/        release-preflight / build-dist / publish-* tooling
```

### Layer order (lower → higher; lower cannot import higher)

```
core → workspace → config → knowledge → rules/paths/templates/pipelines/presets/boundaries
     → packs → generator → importer → inspector → mcp-server → cli
```

`shared/` and `ai/` sit at the edges and only depend on `core` (+ a few stable
peers). Run `bun run check:circular-deps` if a change spans multiple
packages.

---

## Commands

```bash
bun install
shrk <command>                   # CLI (installed globally; use directly)
bun run mcp                      # MCP server (stdio)
bun test                         # full test suite
bun x tsc -p tsconfig.base.json --noEmit
bun run build:dist               # per-package dist/
bun run release:preflight        # the gate before tagging
```

CLI bootstrap commands the agent should know:

```bash
shrk doctor                      # config + entry validation
shrk context --task "<task>"     # focused context for a task
shrk task "<task>"               # full task packet (rules + templates + pipelines + commands)
shrk coverage                    # what's still missing
shrk check boundaries            # boundary enforcement (with tsconfig alias support)
shrk graph why <a> <b>           # shortest-path explanation between two graph nodes
shrk onboard --dry-run           # onboard an existing repo (advisory)
shrk stats                       # per-language file counts, LOC, sizes, averages
shrk dashboard                   # local read-only dashboard (127.0.0.1:4567)
```

---

## Coding standards (enforced as project policy)

- **TypeScript first.** Strict mode on. Interfaces prefixed with `I`. Enums
  preferred over union literals for closed sets.
- **One exported top-level construct per file** (one class OR interface OR
  enum OR type).
- **No logic in constructors** — initialization belongs in explicit lifecycle
  methods.
- **Absolute imports via package names only** — no relative imports across
  package boundaries.
- **Layer order is strict** — lower layers cannot import higher.
- **Errors flow through Result + AppErrorImpl** (`packages/core`), not
  exceptions, on public APIs.

---

## Safety contracts (do not break)

- **MCP never writes.** Every MCP tool is read-only. Even onboarding,
  apply, and generation return next-command hints — the human runs the
  write step on the CLI.
- **Apply requires `--verify-signature` for signed plans** and refuses on
  divergence unless `--allow-divergent` is set.
- **Pack-contributed verification commands are NOT auto-run.** Only commands
  in `sharkcraft.config.ts verificationCommands[]` are eligible for
  `shrk apply --validate --verification <id>`.
- **`shrk onboard --write-drafts` only writes under
  `sharkcraft/onboarding/`.** It never overwrites `rules.ts`, `paths.ts`, or
  `templates.ts`.

---

## When in doubt

- `docs/overview.md` — what SharkCraft is and isn't.
- `docs/philosophy.md` — the non-negotiable design rules.
- `docs/onboarding.md` + `docs/inference.md` — the onboarding engine.
- `docs/security.md` — pack signing + apply guarantees.
- `docs/release-checklist.md` — the preflight gate.

For day-to-day work, **invoke the `sharkcraft-dev` skill** — it walks you
through bootstrapping a session deterministically.
