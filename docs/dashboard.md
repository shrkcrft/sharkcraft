# SharkCraft Dashboard

> **R59 note**: `shrk dashboard` was restored after a brief removal. The
> server (`packages/cli/src/dashboard/dashboard-api-server.ts`), the
> React/Vite UI (`@shrkcrft/dashboard`), and the wire-types package
> (`@shrkcrft/dashboard-api`) are all wired up. A new **Statistics**
> page (see [repository-stats.md](./repository-stats.md)) sits under the
> Codebase group in the sidebar, alongside a regrouped nav and a
> **Repo size** tile on the Overview page.

The SharkCraft Dashboard is a **local, read-only** web UI for the SharkCraft
backend API. It ships as `@shrkcrft/dashboard` (React + Vite).

## What it is

- A read-only **control plane** over the existing SharkCraft data.
- A **report browser**, **session viewer**, and **command discovery surface**.
- A safety cockpit that surfaces MCP read-only invariants, write-capable
  CLI commands, pack signing status, and adoption freshness.

## What it is not

- A code editor.
- A plan apply UI.
- A shell runner.
- A cloud console — it never makes outbound requests.

## Safety model

The dashboard does **not** write anything. Every actionable step is a
copyable CLI command that the user runs intentionally.

- HTTP server: GET and HEAD only. POST/PUT/PATCH/DELETE → 405.
- No write endpoints, no apply endpoints, no shell-execution endpoints.
- Binds 127.0.0.1 by default. Non-localhost host emits a stderr warning.
- Same envelope (`sharkcraft.dashboard-api/v1`) as the API server.
- Static assets are served with `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`.

## Build

```bash
bun install
bun run dashboard:build
# Or, during development:
bun run dashboard:dev          # vite dev server (proxies /api → :4567)
```

`bun run release:preflight` includes `dashboard-build` as a required step.

## Run

```bash
shrk dashboard                                   # default 127.0.0.1:4567
shrk dashboard --port 4567 --open                # open in browser
shrk dashboard --no-open --json                  # CI-friendly
shrk dashboard --api-only                        # serve only the JSON API
shrk dashboard --static-only                     # fail if assets are missing
shrk dashboard --cwd /path/to/project            # inspect a different repo
shrk dashboard --host 0.0.0.0                    # WARN logged; opt-in
```

## API endpoints

See `docs/dashboard-api.md` for the full list. All endpoints return an
`IDashboardApiEnvelope<T>` JSON body:

```json
{
  "schema": "sharkcraft.dashboard-api/v1",
  "generatedAt": "2026-05-13T12:00:00Z",
  "projectRoot": "/abs/path",
  "data": { ... }
}
```

## Pages

| Route                    | Purpose |
|--------------------------|---------|
| `#/overview`             | Repo health, next actions, recent sessions |
| `#/sessions`             | Browse dev sessions |
| `#/sessions/:id`         | Session detail: plans, artifacts, next command |
| `#/quality`              | Quality gates, drift, coverage |
| `#/safety`               | MCP invariant, write-capable / shell-running commands |
| `#/architecture`         | Boundaries / drift / coverage |
| `#/graph`                | Knowledge graph explorer with `why` finder |
| `#/packs`                | Discovered packs, signatures, scaffold patterns |
| `#/presets-pipelines`    | Reusable workflows |
| `#/onboarding`           | Onboarding inference + adoption state |
| `#/reports`              | Reportable artifacts and the commands that render them |
| `#/review-ci`            | Review packets and CI scaffolds |
| `#/commands`             | Searchable command catalog with safety badges |
| `#/mcp`                  | Read-only MCP tool list and setup commands |

## Copy-command UX

Every command on every page renders through `CommandBlock`, which copies the
command to the clipboard on click. The dashboard never executes commands.

## Dashboard data export (R18) + delta (R20)

`shrk dashboard export` writes a flat set of JSON files (repository-map,
architecture, intelligence, packs, role-views, …) into the supplied
output dir. Any read-only UI can consume these — including the bundled
SharkCraft dashboard.

```bash
shrk dashboard export --output .sharkcraft/dashboard-data
shrk dashboard export --include repository-map,architecture,packs
```

R20 adds a diff surface so you can detect drift between two captures
(typical use: CI gate that flags new architecture risks or boundary
violations between branches):

```bash
# Run the export and compare against a prior capture in one step
shrk dashboard export --output .sharkcraft/dashboard-data \
                      --compare-with .sharkcraft/dashboard-data-prev \
                      --format markdown

# Or run the diff explicitly between two existing directories
shrk dashboard diff old/dashboard-data new/dashboard-data --format markdown
```

Diff output is `sharkcraft.dashboard-export-diff/v1`:

- per-section byte-size deltas
- `metrics.{packs, commands, graphNodes, graphEdges, architectureRisks,
  boundaryViolations}` — `{ old, new, delta }` for each

The dashboard server itself is unchanged: it still only serves GET/HEAD
and never writes. The diff surface is a CLI-only read.

## Troubleshooting

- **"Dashboard assets not built."** Run `bun run dashboard:build`. The CLI
  will still start API-only if you pass `--api-only`.
- **Port in use.** Pass `--port 0` to pick a random port, or another value.
- **Wrong cwd.** Pass `--cwd /path/to/project`. The dashboard reflects
  exactly the project root the CLI was given.
- **Empty sessions.** Run `shrk dev start "describe a task"`.
- **No adoption state.** Run `shrk onboard --write-drafts` then
  `shrk onboard adopt --write-patch`.
- **Non-localhost warning.** The dashboard refuses to make this invisible.
  Drop the `--host 0.0.0.0` flag to keep it local.
