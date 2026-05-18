# Testing

SharkCraft uses **Bun's built-in test runner**. Tests live under `packages/<pkg>/src/__tests__/*.test.ts` and run with `bun test` from the repo root.

## Run all tests

```bash
bun test
```

## Run a subset

```bash
bun test packages/knowledge          # one package
bun test --watch                     # watch mode
bun test --rerun-each 3              # detect flakes
```

## What's covered today (v0.1)

| File | What it asserts |
|---|---|
| `core/__tests__/path.test.ts` | `isPathInside` path validation; kebab/pascal/camel/snake case helpers; `joinPath`/`normalizePath`. |
| `knowledge/__tests__/search.test.ts` | Query/tag/scope/appliesWhen filtering, match reasons, priority-based ranking, dedup by id, `defineKnowledgeEntry` validation. |
| `templates/__tests__/render.test.ts` | Variable validation (required, pattern), single-file render, multi-file render, registry register/get/search, preview. |
| `context/__tests__/builder.test.ts` | Section priority order, token-budget omission, scope-based filtering, `includeRules:false`. |
| `generator/__tests__/dry-run.test.ts` | CREATE / SKIP / CONFLICT detection, refusal to write conflicting plans, dry-run returning plan only, `buildNameVariables`. |
| `workspace/__tests__/package-json.test.ts` | `readPackageJson` (missing/malformed/valid), package-manager detection from `packageManager` field and lockfiles, `inspectWorkspace` summary. |

The table above is a (deliberately partial) snapshot of the original core
suite. The full suite has grown to **528+ tests across 102 files** spanning
core, knowledge, templates, context, generator, workspace, inspector (now
covering adoption state + scaffold patterns + dashboard data service +
quality/safety renderers), CLI (catalog doctor, dashboard server, SSE,
report.html, static SPA fallback), MCP server, and the dashboard browser
package (component smoke renders via `react-dom/server`). The set is
intentionally focused on the deterministic core flows — IO-heavy or
environment-coupled paths (real Claude API, MCP transport on the wire)
are exercised by integration probes outside the unit suite, and the
dashboard browser is covered separately by Playwright E2E (see below).

## Adding more

- Stick to `bun:test`'s `describe` / `test` / `expect`.
- Prefer pure assertions; if the test needs file I/O, use `mkdtempSync` under `os.tmpdir()` (see `generator/__tests__/dry-run.test.ts`).
- Do not introduce a heavier framework — `bun test` is the standard.

## Dashboard E2E (Playwright)

SharkCraft has a second test layer for the dashboard UI — Playwright running
against a real browser. It is **opt-in**: not part of `bun test` and not part
of the default `release:preflight`.

### Layers

| Layer | Runner | Where | Purpose |
|---|---|---|---|
| Unit / API / smoke | `bun test` | `packages/<pkg>/src/__tests__/*.test.ts(x)` | Fast deterministic checks. |
| Dashboard E2E | `@playwright/test` | `e2e/*.e2e.ts` | Real browser. Spawns `shrk dashboard` against a fixture. |

The two layers don't replace each other — `bun test` covers the API server,
adoption state, scaffold patterns, command catalog, etc. Playwright covers
what only a browser can: routing, click flows, iframes, CommandBlock copy
state, the read-only safety contract end-to-end.

The Playwright spec files use `*.e2e.ts` (not `*.spec.ts`) so `bun test` does
not pick them up.

### Install Chromium (one-time)

```bash
bun run e2e:install      # downloads Chromium for Playwright (~140 MB)
```

If you skip it, `bun run test:e2e:dashboard` fails with a clear message that
points back to this command. The CI workflow you generate should run
`bun run e2e:install` before the E2E step.

### Run the E2E suite

```bash
bun run dashboard:build              # build the UI first
bun run test:e2e:dashboard           # all e2e/*.e2e.ts in chromium
bun run test:e2e:dashboard:headed    # open a real browser
bun run test:e2e:dashboard:debug     # Playwright inspector
```

The Playwright `webServer` config spawns the dashboard via
`bun run packages/cli/src/main.ts --cwd examples/dashboard-e2e-target dashboard --no-open --port 4677`
and waits for `/api/health` to return 200 before any test starts. Override
the port with `SHRK_DASHBOARD_E2E_PORT=4699 bun run test:e2e:dashboard`.

### Fixture

`examples/dashboard-e2e-target/` is the deterministic project the E2E suite
runs against. It has:

- `package.json` (workspace root).
- `src/app.ts` (so onboarding inference has something to read).
- `.sharkcraft/sessions/2026-05-13-fixture-task/` — one session with
  `session.json`, intent, a plan, and a final report.

Do **not** mutate this fixture from a test. If a test needs to change state,
copy the directory to `os.tmpdir()` first.

### What the suite covers

- App shell + sidebar + topbar; document title reflects the route.
- Overview metrics, recommended commands, recent sessions.
- Sessions list → session detail navigation, plans, artifacts, the report
  iframe (`sandbox=""` verified).
- Quality gates table + recommended commands.
- Safety page MCP write invariant (PASS), write-capable + shell-running
  sections, audit commands.
- Commands page search + safety filter.
- Knowledge graph list ↔ graph view toggle + "Graph why" form.
- Packs, onboarding, MCP, reports, review/CI render.
- **Safety contract**: POST/PUT/PATCH/DELETE on `/api/health`, `/api/overview`,
  `/api/sessions` all return 405; `/api/health.readOnly === true`;
  `/api/capabilities.writeEndpoints === []`; no Apply / Run / Execute
  buttons exist anywhere in the UI.
- `CommandBlock` `Copy` → `Copied` transition without executing.
- SSE smoke: `GET /api/sessions/:id/events` streams the `hello` event.

### Artifacts

On failure, Playwright writes traces, screenshots, and videos under
`test-results/playwright/`:

```bash
bunx playwright show-trace test-results/playwright/<test>/trace.zip
```

This directory and `playwright-report/` are `.gitignore`d.

### Preflight policy

`release:preflight` does NOT run E2E by default. Opt in:

```bash
bun run release:preflight --with-e2e
```

The E2E step is non-blocking (`required: false`) until the suite proves
stable across multiple cold-machine CI runs. Flip it to required after that.

### CI

Add this to a GitHub Actions workflow once you want it on CI:

```yaml
- run: bun run e2e:install
- run: bun run dashboard:build
- run: bun run test:e2e:dashboard
```

`shrk ci scaffold` currently generates the quality/review steps; gating E2E
there (a future `--with-dashboard-e2e` flag) is a follow-up.

### Playwright MCP readiness

Playwright E2E uses the same local dashboard server that a Playwright MCP
server would. The dashboard is read-only, so even an MCP-driven browser
cannot write source through it. Every "dangerous" action the dashboard
surfaces is a copyable CLI command — the human still types
`shrk apply ...` themselves. This invariant is what
`e2e/20-read-only-safety.e2e.ts` exists to defend.

## Dashboard unit / component tests

Lightweight React component checks live under
`packages/dashboard/src/__tests__/`. They render via `react-dom/server` so
they run under `bun test` with no jsdom dependency:

- `api-client.test.ts` — `buildUrl`, `DashboardApiError`.
- `sidebar-smoke.test.tsx` — sidebar nav labels, CommandBlock surface.
- `graph-svg.test.tsx` — GraphSvg populated vs empty.

Use these when you need to assert a component's structure but don't need a
real browser.
