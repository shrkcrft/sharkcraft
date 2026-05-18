# Public alpha — known limitations

This is the canonical list of caveats for SharkCraft 0.1.0-alpha.2.
None of them block adoption, but adopters should be aware.

## Smoke harness

- `shrk release smoke` shells out to `bun packages/cli/src/main.ts`. In
  a published install you should use `shrk install smoke --tarball`,
  which delegates to `bun run release:smoke-test` and exercises the
  same flow against the npm tarball.
- Assertions are best-effort regex / substring matches; they catch
  obvious regressions but do not deeply diff output.

## Onboarding + adoption

- Adoption checkpoints hash the *rendered* JSON diff (with
  `generatedAt` stripped). Upgrading SharkCraft itself may rewrite the
  diff format and invalidate checkpoints once — re-run with
  `--record-checkpoint`.
- Three-way previews assume a clean working tree; modify-then-adopt is
  not supported in the alpha.

## Pack compat

- `--dist-aware` only walks `dist/*.{js,mjs,cjs}`; nested entry points
  need the consumer-root to be the parent. Re-exports through deeply
  nested barrels are not traced.
- The scanner is regex-based, not a full TS analyser. It catches the
  dominant failure mode (`Export named X not found`) but doesn't
  resolve `export *` across multiple files.

## Bundle diff

- Rename detection uses fixed weights (template id 0.4, target Jaccard
  0.3, variables 0.2, review file 0.1). Edge cases (rename + major
  drift simultaneously) still surface as remove+add.

## Release readiness

- Strict mode warns on missing `docs/releases/<version>.md`,
  `docs/public-alpha-limitations.md`, `docs/external-repo-quickstart.md`,
  and `CHANGELOG.md`. R17 ships all four for `0.1.0-alpha.2`.
- The preflight summary fold-in now warns when older than 7 days.

## Demo package

- `demo package --validate` requires the catalog to be up-to-date.
  Unknown command references become *warning*, not error — the alpha
  emphasises low friction.

## CI permissions fix preview

- Only GitHub Actions emits a real unified-diff patch; GitLab / Bitbucket /
  Azure / Jenkins return advice + insertion blocks. Plumbing for
  provider-specific patches is on the R18 roadmap.

## MCP

- `get_release_smoke_report` and `get_install_smoke_report` return the
  *plan*; MCP never spawns subprocesses. The CLI is the only path that
  actually executes the steps.
- `get_dashboard_summary` includes a `releaseReadiness` and
  `releaseSmoke` summary when the local artifact exists; the smoke
  summary's age field can be used to detect stale reports.

## Dashboard

- The dashboard runs as a local server only; remote access is not
  exposed. Read-only contract is exercised by
  `e2e/20-read-only-safety.e2e.ts`.
- Some Vite assets are JS-loaded inside the dashboard UI; the safety
  guarantee is on the *server* (GET/HEAD only).

## Bun ↔ Node

- Development uses Bun ≥ 1.1.
- Publish targets a Node-compatible runtime. `bun run compat:node`
  audits for `Bun.*` API usages in `dist/`. The CLI itself is launched
  via `bun` in development; the published binary will rely on the Node
  runtime.

## Not in scope

- No AI runtime.
- No telemetry.
- No SaaS / cloud / billing / licensing surface.
- No autonomous write step from the agent side.
- No remote-MCP support beyond what `@modelcontextprotocol/sdk` offers.
