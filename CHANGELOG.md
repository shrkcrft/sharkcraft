# Changelog

All notable changes to SharkCraft are documented here. Format roughly
follows [Keep a Changelog](https://keepachangelog.com/) and SharkCraft uses
[semver](https://semver.org/). During alpha, breaking changes can land in
any release — pin exact versions.

## [0.1.0-alpha.7] — 2026-05-19 — NestJS 11+ and React 19+ preset families

Seventeen new presets and 70+ new rule snippets across two stacks —
the modern NestJS service surface (Nest 11+) and the modern React app
surface (React 19+). Both mirror the alpha.6 Angular 21 family in
shape: focused presets each owning one slice, plus a comprehensive
preset that composes them.

### Added — React 19+ family

- **`@shrkcrft/presets`** — `react19-snippets.ts` and
  `react19-presets.ts`. Rule snippets cover: function components (no
  React.FC, no class components for new code); props as interfaces;
  ref-as-a-prop (no forwardRef in the common case); `<Context>` as the
  provider directly (no `.Provider`); document metadata in the tree;
  scoped stylesheets via `<link precedence>`; self-closing JSX; rules
  of hooks; `useEffect` ONLY for external-system sync (no derived
  state, no event responses, no fetches); `key` prop for state reset
  (not useEffect); custom hook naming + cleanup; the React 19 Actions
  surface (`<form action>`, `useActionState`, `useFormStatus`,
  `useOptimistic`, `use()`); async functions in `startTransition`/
  `useTransition`; server state in TanStack Query / SWR / RTK Query;
  client state shape proportional to scope; React Hook Form + Zod for
  non-trivial forms; the React Compiler obsoleting most hand-rolled
  `useMemo`/`useCallback`; code-splitting via `React.lazy` + Suspense;
  list virtualization past ~100 visible rows; stable list keys;
  explicit image dimensions + `loading="lazy"`; `useTransition`/
  `useDeferredValue`/Suspense boundaries; StrictMode in dev; Vitest +
  Testing Library + `userEvent` + MSW; React Server Components
  default with `"use client"` pushed to interactive leaves, Server
  Actions for mutations, streaming SSR through Suspense.

- **Nine new presets** (weight 11-12, beats the legacy `frontend-app`
  at weight 6 in the recommender):
  - `react-19-modern-components` — function components, ref-as-prop,
    Context-as-provider, document metadata in the tree.
  - `react-19-hooks-discipline` — rules of hooks, useEffect for
    external sync only, key-for-reset, custom-hook naming + cleanup.
  - `react-19-actions-forms` — Actions, useActionState, useFormStatus,
    useOptimistic, use(), async transitions.
  - `react-19-state` — TanStack Query for server state, the right
    shape for client state, RHF + Zod for forms, no prop-drilling.
  - `react-19-performance` — React Compiler, lazy + Suspense,
    virtualization, stable keys, image optimization.
  - `react-19-concurrent` — useTransition, useDeferredValue,
    deliberate Suspense placement, StrictMode in dev.
  - `react-19-testing` — Vitest + Testing Library + userEvent + MSW,
    behavior-not-implementation testing posture.
  - `react-19-rsc` — Server Components default, `"use client"` at the
    leaf, Server Actions, streaming SSR. Intentionally NOT pulled in
    by `react-19-modern` since it only applies to RSC frameworks
    (Next.js app router, Remix, Waku).
  - `react-19-modern` — comprehensive; composes the seven non-RSC
    focused presets. Add `react-19-rsc` separately for fullstack apps.

- **Path snippets** — `REACT_PATH_COMPONENTS`, `REACT_PATH_HOOKS`,
  `REACT_PATH_PAGES`, `REACT_PATH_LIB` in `shared-snippets.ts`, each
  with structured `metadata.path` so the init paths-advisory annotator
  catches mismatches (e.g. a Next.js app-router project that uses
  `app/` instead of `src/pages/`).

- **Tests** — `packages/presets/src/__tests__/react19-presets.test.ts`
  asserts: all nine presets are registered; `react-19-modern`
  composes the seven non-RSC focused presets and intentionally does
  NOT compose `react-19-rsc`; each focused preset includes its
  canonical rule (e.g. `useActionState` in actions, `Vitest` + `MSW`
  in testing, `"use client"` + `"use server"` in RSC); every emitted
  .ts is self-contained; the recommender picks a `react-19-*` preset
  for a React frontend workspace.

### Added — NestJS 11+ family

### Added — NestJS 11+ family content

- **`@shrkcrft/presets`** — `nest11-snippets.ts` and `nest11-presets.ts`.
  Rule snippets cover: thin controllers / service-owns-domain /
  module-per-feature / module public-API / no-circular-modules /
  DTOs-at-boundary / no-query-in-controller; global ValidationPipe
  with whitelist + forbidNonWhitelisted + transform; class-validator
  DTOs as classes (not interfaces); separated request / response DTOs;
  `@ApiProperty` for OpenAPI; lifecycle hooks (OnModuleInit /
  OnApplicationBootstrap / OnModuleDestroy / OnApplicationShutdown);
  `enableShutdownHooks()` at bootstrap; async `useFactory` providers;
  Fastify adapter; `@nestjs/cache-manager`; `@nestjs/throttler`;
  mandatory pagination on list endpoints; helmet; explicit CORS
  allowlist (no `origin: true` in prod); JWT auth via Guards (not
  middleware); no-secrets-in-source; trust-proxy when behind a load
  balancer; per-provider `Logger(MyService.name)`; structured JSON
  logs (pino / nest-winston); no-log-secrets redaction; `@nestjs/terminus`
  health checks with split liveness + readiness; `Test.createTestingModule`
  + `overrideProvider`; e2e via supertest against the real AppModule;
  unit specs co-located vs e2e under `test/`; URI API versioning when
  the contract is external.

- **Eight new presets** (weight 11-12, beats the existing
  `nestjs-service` at weight 7 and `nest-service` canonical alias at
  weight 9 in the recommender):
  - `nest-11-architecture` — module + controller + service +
    repository structure, DTOs at the HTTP boundary.
  - `nest-11-validation` — global ValidationPipe strict-mode +
    class-validator DTOs + separated request / response shapes.
  - `nest-11-async-lifecycle` — async providers + lifecycle hooks +
    `enableShutdownHooks()`.
  - `nest-11-performance` — Fastify adapter + caching + throttling +
    mandatory pagination.
  - `nest-11-security` — helmet + CORS allowlist + JWT guards +
    no-secrets + trust-proxy + throttler.
  - `nest-11-observability` — per-provider Logger + structured JSON
    logs + redact-list + terminus health (liveness + readiness).
  - `nest-11-testing` — TestingModule + overrideProvider unit specs
    + supertest e2e + co-located vs `test/` file layout.
  - `nest-11-modern` — composes all seven, layers on URI API
    versioning.

- **Tests** — `packages/presets/src/__tests__/nest11-presets.test.ts`
  asserts: all eight presets are registered; each canonical rule is
  present in its area (e.g. `enableShutdownHooks` in async-lifecycle,
  `helmet` + `JwtAuthGuard` + `trust-proxy` in security, `terminus`
  + `liveness` + `readiness` in observability); every emitted .ts is
  self-contained; `recommendPresets` picks a `nest-11-*` preset for a
  NestJS+backend+service workspace.

### Changed

- **Auto-pick tests updated for both stacks** —
  `r47-adoption-top5.test.ts` now expects the new canonical winners:
  `nest-11-modern` (weight 12) supersedes `nest-service` (weight 9)
  for NestJS workspaces; `react-19-modern` (weight 12) supersedes
  `react-app` (weight 6) for React workspaces. The legacy ids stay in
  the catalog and remain reachable via explicit
  `--preset nest-service` / `--preset react-app` for projects that
  pin them.
- **One MCP test got a longer timeout** — `create_execution_graph
  returns nodes and edges` calls `inspectSharkcraft()` which walks
  the whole engine repo and the catalog is bigger now (3 new preset
  families). Bumped the per-test timeout to 30s so the test doesn't
  flake under full-suite contention.

### Removed

- **Unscoped `shrk` wrapper package.** The repo previously shipped a
  `packages/shrk/` thin forwarder so users could type
  `npx shrk@alpha init` instead of `npx @shrkcrft/cli@alpha init`. The
  unscoped name was blocked by npm's anti-typosquatting check on
  first publish (too similar to `shx`, `sharp`, `swr`, etc.) and the
  wrapper added no functional surface — `@shrkcrft/cli` already
  declares `bin: { shrk: "./dist/main.js" }`, so once the scoped
  package is installed, the `shrk` binary is on PATH from it directly.
  Canonical install commands are now:
  ```bash
  npx @shrkcrft/cli@alpha init     # one-shot
  npm install @shrkcrft/cli@alpha  # then `shrk` on PATH (or via npx --no-install shrk)
  ```
  The 22 scoped packages are unchanged and contain all the
  functionality. README + docs updated accordingly.

### Why

Same logic as alpha.6's Angular 21 family. The legacy presets predate
the patterns most teams now treat as table stakes — for Nest:
Fastify, strict ValidationPipe, terminus health, explicit CORS
allowlist, structured logging, throttler defaults. For React:
function components only, hooks discipline (useEffect for external
sync only), Actions/useActionState, server state in TanStack Query,
React Compiler auto-memo, Vitest + Testing Library. Rather than
rewrite the legacy presets in-place and break consumers who pinned,
the alpha.7 set ships alongside as a higher-weighted family.

### Added — Distribution + UX (agent feedback follow-up)

A downstream Claude agent flagged three friction points using `shrk` in
a host repo. All three are addressed in this slice.

- **`npx shrk@alpha` resolves on the public registry.** New unscoped
  wrapper package at `packages/shrk/` — its sole job is to depend on
  `@shrkcrft/cli` and forward to `runCli()`. Same surface, same flags,
  same exit codes. The published `bin` is `dist/bin.js` (named
  `bin.js`, not `main.js`, so the CLI's own entry-point guard does not
  double-fire when both modules load). Source: `packages/shrk/src/bin.ts`,
  `packages/shrk/src/index.ts`, `packages/shrk/package.json`. Existing
  scripts (`publish-packages`, `install-smoke-test`, `release-preflight`)
  pick up the new package automatically via `discoverPackages`.

- **Doctor headline no longer drowns in `actionhints-*` warnings.**
  `runDoctor` in `packages/inspector/src/sharkcraft-inspector.ts` now
  flags every action-hint quality check with `advisory: true`. The
  existing fold pipeline (`foldDoctorChecks` in
  `packages/cli/src/doctor/doctor-tags.ts`) already knew how to
  collapse advisory warnings into a one-line summary —
  `Folded: N advisory (run with --show-advisory or --strict to expand)`.
  `--strict=warnings` continues to exclude hint-quality (existing
  contract); `--strict=all` continues to count them; JSON output is
  unchanged. A real downstream repo with 367 of these now shows a
  single summary line by default. Test:
  `packages/inspector/src/__tests__/actionhints-advisory.test.ts`.

- **`shrk check boundaries --watch` for inner-loop iteration.** The
  watch helper at `packages/cli/src/output/watch-loop.ts` gained a
  `defaultPaths` option and a `--paths a,b,c` flag pass-through, so
  callers that scan source outside `sharkcraft/` can watch the right
  trees. `checkBoundaries` in
  `packages/cli/src/commands/check.command.ts` now wraps its single-
  shot path through `maybeRunInWatchMode`, defaulting the watched set
  to `sharkcraft / packages / apps / libs / src / tools`. Flags:
  `--watch [--paths <list>] [--debounce N] [--once]`. Test added in
  `packages/inspector/src/__tests__/r31-feature-accelerator.test.ts`.

### Why — agent feedback follow-up

The three issues all came from the same source: a downstream Claude
agent reporting that `shrk` earns its keep for boundary enforcement
and the AI workflow, but the install story (`npx shrk` 404) and the
inner loop (doctor nag, no boundary watch) made onboarding rougher
than it should be. The fixes are intentionally small and surgical —
no new abstractions, no rewrites — because the engine itself is fine;
only the surface in front of it needed sharpening.

### Fixed — Dist-under-Node TypeScript loading (`npx shrk` parity)

A second round of feedback surfaced the *deeper* part of the same
distribution issue: `npx shrk` resolved, but it couldn't actually
read user `sharkcraft/*.ts` files because Node's `import()` doesn't
speak TypeScript. The CLI silently degraded to "no boundary rules
configured" and "AI-readiness 18/100" against a fully configured
host repo, while `bunx shrk` worked normally. This made the npm
path effectively cosmetic.

- **New `importModuleViaLoader` helper in `@shrkcrft/core`.** When
  running under Node (not Bun) and the target file ends in
  `.ts`/`.tsx`/`.mts`/`.cts`, the helper routes the import through
  [jiti](https://github.com/unjs/jiti) (a tiny TS-aware loader, oxc-
  backed in v2). Under Bun, native `import()` is used unchanged — no
  added latency for the dev path. The jiti instance is lazy-loaded
  and cached.
- **jiti added as a dependency of `@shrkcrft/core`** (`^2.7.0`). It
  is the only addition; every other engine package gets it
  transitively. Library consumers who only import types or pure
  utilities still pay nothing at runtime — jiti loads only when a
  TypeScript file is dynamically imported.
- **23 raw `import(pathToFileURL(file).href)` call sites migrated**
  to `importModuleViaLoader` across `@shrkcrft/config` (config
  loader), `@shrkcrft/inspector` (every registry / loader that
  consumes user-authored TS), and `@shrkcrft/cli/commands/packs*`.
  The migration was scripted (`scripts/migrate-loader-imports.ts`)
  so the diff is mechanical and idempotent.
- **`shrk` wrapper now pins `@shrkcrft/cli` exactly at publish.**
  New `publishPinExact: ["@shrkcrft/cli"]` metadata in
  `packages/shrk/package.json`; `buildPublishPkg` in
  `scripts/lib/publish-mode.ts` honors it by emitting the version
  without a caret. Prevents the wrapper and the CLI drifting across
  releases (a version skew there silently breaks the contract).
- **Flake fix.** `r23-mcp-tools > create_agent_contract` got a 30s
  timeout to match its sibling — same suite-contention story as
  `create_execution_graph`.

End-to-end verification: `node packages/cli/dist/main.js check
boundaries` now returns `2 rules · 1491 files · 5318 imports · 0
violations` (identical to `bun packages/cli/src/main.ts check
boundaries`), and `doctor` reports 75/100 (not 18/100). Test:
`scripts/__tests__/publish-mode.test.ts` adds a case for the
`publishPinExact` transform.

### Hardened — release gate and strict-mode generality

Three small follow-ups to lock in the stability gains and remove the
last bit of accidental coupling in the advisory-warning treatment.

- **`install-smoke-test` now exercises the TS loader end-to-end.**
  Post-init, the smoke test parses doctor output and asserts:
  knowledge entries > 0 AND AI-readiness ≥ 50. It then writes a
  sentinel `sharkcraft/boundaries.ts` rule, points the config at it,
  and runs `npx shrk check boundaries` — failing if rule count < 1.
  The previous test passed even when the Node-side TS loader was
  fully broken (the "Verdict:" line printed regardless). This closes
  the blind spot at release time. `scripts/install-smoke-test.ts`.

- **`doctor --strict=warnings` now keys off `check.advisory === true`,
  not `id.startsWith('actionhints-')`.** Future advisory categories
  (template quality, rule quality, anything else flagged advisory)
  are automatically respected by strict mode without a code edit. The
  string-prefix special case was a quiet correctness trap. Same flag
  surface, more general semantics. `packages/cli/src/commands/doctor.command.ts:91-125`.

- **Removed the one-shot `scripts/migrate-loader-imports.ts`.** Its
  job (migrating 23 raw `import(pathToFileURL(...))` sites to the
  jiti-aware helper) is done. Leaving it in the repo would have
  confused the next contributor into wondering if they needed to
  update it.

## [0.1.0-alpha.6] — 2026-05-18 — Angular 21 preset family

Six new presets and 24 new rule snippets covering the post-decorators
era of Angular (18 / 19 / 20 / 21). Signal-based queries, signal-based
I/O, zoneless change detection, the new template control flow, the
resource() / httpResource() async APIs, and the inject()-based modern
DI surface.

### Added

- **`@shrkcrft/presets`** — `angular21-snippets.ts` and
  `angular21-presets.ts`. Rule snippets cover: signal state /
  computed / effect / linkedSignal; signal-based `viewChild()` /
  `viewChildren()` / `contentChild()` / `contentChildren()`;
  signal inputs (`input()` / `input.required()`); `output()` and
  `model()`; `provideZonelessChangeDetection()` and the
  no-NgZone-APIs posture; the new control flow (`@if` / `@for` /
  `@switch` / `@defer` / `@let`); self-closing tags;
  `NgOptimizedImage`; `inject()` over constructor DI;
  `afterRender` / `afterNextRender`; `providedIn: 'root'`;
  no-NgModules / `bootstrapApplication` + `provideX()` style;
  `resource()` / `httpResource()`; hybrid rendering;
  `provideHttpClient(withFetch())`; signal-forms interop via
  `toSignal()`; signal-input setting in tests via
  `fixture.componentRef.setInput()`.
- **Six new presets** (weight 11-12, beats the older `modern-angular`
  at weight 9 when the workspace declares HasAngular):
  - `angular-21-signals` — local state + queries + inputs + outputs +
    `model()` two-way binding.
  - `angular-21-zoneless` — zoneless CD bootstrap + the
    no-NgZone-APIs posture + `afterRender` lifecycle.
  - `angular-21-control-flow` — `@if` / `@for` / `@switch` / `@defer`
    / `@let`, self-closing tags, `NgOptimizedImage`.
  - `angular-21-resource` — `resource()` and `httpResource()` as the
    canonical async primitives, `linkedSignal` for writable derived
    state.
  - `angular-21-modern-di` — `inject()` function, `providedIn root`,
    no new NgModules, `bootstrapApplication()` + `provideX()` family.
  - `angular-21-modern` — the comprehensive preset that composes all
    five focused ones. Also pulls in hybrid-rendering and the test
    rules for signal inputs and zoneless CD.
- **Tests** — `packages/presets/src/__tests__/angular21-presets.test.ts`
  asserts: all six presets are registered; the canonical rule for each
  area is present (e.g. `viewChild` mentioned in the signals preset,
  `provideZonelessChangeDetection` in the zoneless preset); every
  emitted .ts is self-contained; `recommendPresets` picks an
  `angular-21-*` preset when the workspace is Angular.

### Why

The existing `modern-angular` family (alpha.5 and earlier) was written
when Angular 16/17 was current and predates the signal-query /
signal-I/O / zoneless / resource API surface. Rather than rewrite it
in-place and break consumers who pinned to it, the alpha.6 set lives
alongside as a separate, higher-weighted family. New projects get the
Angular 21 stack by default; projects pinned to `modern-angular` keep
their existing behaviour.

### Migration notes

Same as alpha.4 / alpha.5 — no automatic migration. To pick up the new
presets in an existing repo:

```bash
shrk init --preset angular-21-modern --dry-run  # preview
shrk init --preset angular-21-modern --write    # commit if happy
```

For projects already on a preset preset and willing to switch, the
generated `sharkcraft/*.ts` files are mergeable — the local-mirror
preamble means the new and old files have the same exported shape, so
hand-merging rule arrays works.

## [0.1.0-alpha.5] — 2026-05-18 — Framework-correct paths for Nx, Angular, Nest, polyglot

Follow-up to alpha.4 that fixes the second half of the benchmark finding:
the Nx / Angular / Nest / polyglot presets now ship path conventions that
actually match their target frameworks, so `shrk init --preset nx-monorepo`
in a real Nx repo no longer emits a `paths.ts` advisory listing
`src/services/` as missing.

### Added

- **Framework-specific path snippets** in `@shrkcrft/presets` —
  `NX_PATH_LIBS` / `NX_PATH_APPS` (Nx); `ANGULAR_PATH_APP` /
  `ANGULAR_PATH_COMPONENTS` / `ANGULAR_PATH_SERVICES` (single-app
  Angular); `NEST_PATH_SRC` / `NEST_PATH_E2E` (NestJS, including the
  `test/` directory used by Nest e2e suites); `WORKSPACE_PATH_PACKAGES`
  / `WORKSPACE_PATH_APPS` (Turborepo, npm/pnpm/yarn workspaces);
  `JAVA_MAVEN_PATH_MAIN` / `JAVA_MAVEN_PATH_TESTS`; `PYTHON_PATH_SRC` /
  `PYTHON_PATH_TESTS`; `GO_PATH_CMD` / `GO_PATH_PKG` / `GO_PATH_INTERNAL`;
  `RUST_PATH_SRC` / `RUST_PATH_TESTS`. Each snippet carries a structured
  `metadata.path` field so the init paths-advisory annotator can verify it
  against the live workspace.

### Changed

- **Presets now use framework-correct paths.** The presets that previously
  emitted the generic `src/services/` / `src/utils/` / `tests/` triple
  even when they targeted a specific framework have been switched to the
  new snippets:
  - `nx-monorepo` → `libs/`, `apps/`
  - `angular-app` (built-in and R47 canonical), `modern-angular` →
    `src/app/`, `src/app/components/`, `src/app/services/`
  - `nest-service` (R47), `nestjs-service` (R26) → `src/`, `test/`
  - `turborepo`, `package-workspace` → `packages/`, `apps/`
  - `java-maven-service`, `java-gradle-service` → `src/main/java/`,
    `src/test/java/`
  - `python-service` → `src/`, `tests/`
  - `go-module` → `cmd/`, `pkg/`, `internal/`
  - `rust-crate` → `src/`, `tests/`

### Migration notes

Same as alpha.4 (below). No code-side migration required.

## [0.1.0-alpha.4] — 2026-05-18 — Self-contained init scaffolding

Fixes the root cause behind the alpha.1–alpha.3 benchmark finding that
`shrk` was net-negative in a freshly-init'd downstream repo: every
generated `sharkcraft/*.ts` file used to import from `@shrkcrft/*`
packages, but those packages weren't published yet, so every loader
failed and the project-intelligence layer was offline.

### Fixed

- **No `@shrkcrft/*` imports in any generated scaffolding.** Every
  emitter — `INIT_FILES` (legacy seed), `synthesizePresetFiles()`
  (modern preset path), `emitKnowledgeTs()` (importer),
  `renderConstructDraftsModule()` / `renderRulesDraft()` /
  `renderPathsDraft()` / `renderBoundariesDraft()` /
  `renderConstructsDraft()` (inspector), `rule-scaffold.ts`,
  `construct-adoption-diff.ts` — now produces self-contained TypeScript
  that declares its own minimal helpers (`function defineKnowledgeEntry<T>(e: T): T { return e; }`)
  and enum-like constants inline. The knowledge / templates / pipelines
  loaders are shape-agnostic, so the structured fields still work
  exactly the same way without the import.
- **Surface-config writer no longer falls back to a broken
  `defineSharkCraftConfig` block.** `applySurfaceTextEdit` now handles
  three config patterns — `defineSharkCraftConfig({...})`, `const config = {...}; export default config`,
  and `export default {...}` — so injecting a `surface:` block into the
  new plain config no longer appends a stray import.
- **`sharkcraft.config.ts` is now a plain `export default {...}`.** The
  config loader validates by shape via zod, so the helper call was never
  required.

### Added

- **`packages/cli/src/init/paths-advisory.ts`** — after writing
  `sharkcraft/paths.ts`, init scans every `path: '<x>'` and
  `metadata.path: '<x>'` reference and classifies each `<x>` against the
  live workspace. If any are missing on disk, a clearly-labeled
  `⚠️ Workspace-shape advisory` comment block is prepended to the file
  listing the absent paths, and a `Paths advisory` block is printed to
  stdout. Idempotent and non-destructive — the original entries stay so
  the user can edit them in place.
- **Regression test:** `init-self-contained-emit.test.ts` asserts
  no `@shrkcrft/*` / `@sharkcraft/*` `from '...'` lines in any output of
  the legacy seed, every built-in preset, `emitKnowledgeTs`, and a real
  `shrk init --write` against a tmp project root.

### Build / CI

- **`scripts/build-dist.ts` now also builds the dashboard via Vite** so
  `publish:dry-run` finds `packages/dashboard/dist/index.html` on CI.
- **`scripts/audit-doctor-json.ts` invokes the CLI via
  `bun run packages/cli/src/main.ts`** instead of a globally-installed
  `shrk` binary, so the audit runs on CI even before `build:dist`.
- **`safe-import.test.ts` no longer depends on a Bun deadlock bug**
  that was fixed in newer Bun. The hang scenario uses a top-level
  `await new Promise(() => {})` to construct a deterministic
  never-resolves dynamic import.

### Migration notes — existing user repos

Anyone whose `sharkcraft/` folder was generated by `shrk init` /
`shrk presets apply` on alpha.1–alpha.3 still has `import { ... } from
'@shrkcrft/*'` lines at the top of every `*.ts` file in that folder. The
SharkCraft engine itself runs against shape, not imports, so older
projects keep working — but only because the loader's `safeImport` step
catches the failed resolution and skips silently. To restore full
knowledge / rules / paths / templates loading:

```bash
# pick one:
# (a) regenerate (overwrites local sharkcraft/*.ts — back up first):
shrk init --legacy --write --force

# (b) hand-edit each sharkcraft/*.ts:
#     remove the `import { ... } from '@shrkcrft/...'` lines and replace
#     `defineKnowledgeEntry(x)` / `defineRule(x)` etc. with the inline
#     stub `function defineKnowledgeEntry<T>(e: T): T { return e; }`.
#     The repository's own sharkcraft/*.ts files demonstrate the pattern.
```

The `shrk doctor` advisory output now flags surface-profile drift; if
your project's `sharkcraft.config.ts` carries an outdated
`surface.profile` value, doctor will print which profile it would pick
today.

## [Unreleased] — Cleanup: remove project-specific references and cycle markers

The engine and its assets were carrying project-specific knowledge and
internal development markers that leaked into source, docs, tests, and the
public surface. This round makes the repo project-agnostic by construction
— no SharkCraft asset, test, or doc mentions a particular consumer project
— and strips the `R##` development-cycle markers that are meaningful only
inside SharkCraft's own planning loop. The visible behavior of every
command is unchanged; the surface is just honest about what it is.

### Removed

- **Root cruft** — planning/feedback markdown files at the repo root and
  the `development/` directory (working-notes only; not part of the
  shipping product). These were never published, never referenced from
  `docs/`, and only added noise to clones.
- **Engine purity tests** that hardcoded a project-specific token
  allowlist. Their guardrail role is superseded by the fact that the
  engine is now project-agnostic by construction — the assertion they
  made ("no project-specific strings in engine code") becomes vacuous
  after this cleanup, so keeping them would be testing the test rather
  than the engine.
- **Three adopter-gated integration tests** —
  `knowledge-graph-path.test.ts`, `task-ranker.test.ts`,
  `test-runner-diagnostics.test.ts`. Each skipped at runtime for external
  consumers (they only ran when a sibling adopter repo was resolvable on
  disk), so they contributed zero coverage to anyone outside Anthropic's
  working copy. Equivalent behaviour is exercised by the existing
  `examples/dogfood-target` and `examples/unconfigured-*` fixtures.

### Changed

- **Project-specific text stripped from source, tests, docs, and README.**
  Every prose mention of a particular consumer project / sample task
  descriptions referring to consumer-specific features was rewritten to
  be either project-agnostic ("an adopter pack", "your repository") or
  removed if it added nothing for an external reader.
- **`R##` cycle markers stripped from JSDoc, inline comments, asset
  descriptions, and test names.** The `R12 adds …` / `R14 introduces …`
  prefixes were SharkCraft's internal planning shorthand and meant
  nothing to a first-time reader. Behaviour is preserved; provenance is
  still recoverable from `git log` and the CHANGELOG's existing
  per-round entries.
- **Feature-key naming aligned to `FEATURE_KEYS`** in documentation
  copy and test fixtures (matching the engine's own canonical naming
  used by `r28-feature-accelerator.test.ts` and
  `r35-feature-accelerator.test.ts`). The runtime symbol was already
  `FEATURE_KEYS`; only stale prose and fixture filenames disagreed.
- **`packages/inspector/.../feedback-actions-v2.ts` origin regex
  generalized** — dropped the project-specific alternative from the
  trusted-origin filter so a pack's origin must match the engine's
  published-origin policy rather than a hardcoded consumer prefix.

### Added

- **`.gitignore` rules** for `.nx/`, `.sharkcraft/`, `quality.html`, and
  `.tmp-*` — local-only outputs from `bun nx` / `shrk quality` / smoke
  scripts that were occasionally leaking into clean clones.

### Safety contracts (unchanged)

- No MCP write tools added or removed.
- No CLI verb removed (this is a copy / fixture / dotfile pass, not a
  surface change).
- All 1746 tests pass on this commit.
- Plan-signing, pack-signing, and apply guarantees are unaffected — the
  rename in `feedback-actions-v2.ts` makes the origin allowlist *more*
  conservative, not less.

## [Unreleased] — R58: additive SDD — shrk grounds YOUR spec, doesn't own it

R58 makes the SDD value available against any external spec/plan
format. The opinionated `shrk spec` surface from R57 stays for teams
that want the audit-trail; R58 adds the additive path for teams that
already use a Claude SDD plugin / Cursor / Aider / homegrown tooling.

**The contract:** if shrk is uninstalled tomorrow, the repository is
bit-identical to before. shrk's value is purely *additive* —
grounding + validation — and nothing in `docs/`, `plans/`, or any
team file format depends on it.

### Added

- **`shrk grounding "<task>" [--json]`** — single-call context primer
  for plugin / skill consumption. Returns task-relevant rules,
  knowledge, paths, templates, and trusted verification command IDs
  as `sharkcraft.grounding/v1`. Read-only; composes
  `buildTaskPacket` + `searchKnowledge`; no LLM, no shell.
- **`shrk plan check <path>`** — validate ANY external plan/spec
  file against the live workspace. Two built-in extractors
  (`sharkcraft.spec/v1`, `markdown-frontmatter-loose`) and an
  optional `--field-map` for team-specific key remapping. The input
  file is NEVER modified. Returns `sharkcraft.plan-check/v1`.
- **`IPlanExtractor` interface + `IExtractedPlan` shape** in
  `@shrkcrft/generator/grounding`. Internal contract; not exposed
  as a pack plugin-api in R58 (no current consumers).
- **`validateExtractedPlan`** in `@shrkcrft/inspector/grounding` —
  the shared cross-registry validator now used by both R57
  `spec review` and R58 `plan check`. R57's `buildSpecReview` /
  `validateSpecAgainstWorkspace` are thin shims over this pipeline.
- **`loadNxProjects` / `mapFilesToProjects`** — pure-fs Nx project
  graph reader (no shell-out to `nx` CLI). Powers `plan check`'s
  cross-project warning when `nx.json` is present; degrades cleanly
  when absent.
- **`mcp__sharkcraft__get_grounding`** — read-only MCP sibling of
  `shrk grounding`.
- **`mcp__sharkcraft__check_external_plan`** — read-only MCP sibling
  of `shrk plan check`. Accepts either a `path` or inline `content`.
- **Additive-contract test** (`r58-additive-contract.test.ts`) —
  asserts every tracked file outside `.sharkcraft/` is byte-identical
  before / after running the full R58 surface. Mechanically enforces
  the additive principle.

### Changed

- **`packages/inspector/src/spec/spec-cross-validate.ts`** — R57
  `validateSpecAgainstWorkspace` is now a 30-line shim that projects
  the `ISpecJson` onto `IExtractedPlan` and delegates to
  `validateExtractedPlan`. No wire-shape change; R57 tests stay
  green.

### What R58 explicitly cut from the original plan

Documented in `.sharkcraft/reports/r58-additive-audit.md`. Trimmed
items: `--format skill` text envelope, `propose_grounding` MCP tool,
`markdown-heuristic` regex extractor, pack-contributable extractors,
`shrk doc index --extra-paths` (deferred to R59), `externalSpecs[]`
config block (R59), `shrk boundaries infer --from-nx-tags`, the R50
per-round-budget catalog refactor, and Nx integration in
`shrk grounding`. All cuts are justifiable: no current consumer
needed any of them, and shipping speculative surface is exactly the
"bullshit" R58 was supposed to avoid.

### Safety contracts (unchanged)

- MCP never writes. Two NEW read-only tools, zero new write tools.
- The R57 spec surface keeps working with no wire-shape change.
- `shrk grounding` and `shrk plan check` write nothing — the
  additive-contract test mechanically enforces this every CI run.
- No project-specific logic. Adopter packs do NOT need re-signing.

## [Unreleased] — R57: `shrk spec` — intent artifact over plan/review/apply

R57 ships the SDD (spec-driven development) thread from `planning2.md`
as a thin layer over the existing plan/review/apply pipeline. Same
engine, same safety contract, no AI in the engine, no new asset kinds.

### Added

- **`shrk spec <create|review|implement|verify|list|show|status|lint>`** —
  one new top-level verb with eight subcommands. Preview-first
  everywhere; `--write` / `--apply` are opt-in.
- **`sharkcraft.spec/v1`** — frontmatter schema for the spec artifact.
  Lives at `.sharkcraft/specs/<id>/spec.md`. The frontmatter is
  authoritative; the markdown body is inert documentation, capped at
  16 KiB by default.
- **`sharkcraft.spec-review/v1`** — read-only validation report shape.
  Structural validation lives in `@shrkcrft/generator`;
  cross-registry resolution (rule / knowledge / path / template /
  verification command id checks) lives in `@shrkcrft/inspector`.
- **`sharkcraft.spec-implement/v1`** — combined-plan envelope. The
  combined plan is signed by `signPlan` with a note of
  `spec=<id>; frontmatter=<hash>` so the signature is unique to the
  spec AND its content version.
- **`sharkcraft.spec-verification/v1`** — verify report shape.
  `spec verify` runs ONLY trusted verification commands from
  `sharkcraft.config.ts verificationCommands[]` (matching the R44
  hard rule). Includes diff-aware scope-drift detection and plan
  signature integrity check.
- **`sharkcraft.spec-list/v1`** — `spec list` output.
- **`sharkcraft.spec-events/v1`** — per-spec append-only event log at
  `.sharkcraft/specs/<id>/events.jsonl`.
- **Provenance `relatedSpec` back-pointer** — `IAssetProvenanceEntry`
  gains an optional `relatedSpec` field. Schema bumps to
  `sharkcraft.asset-provenance/v2` IFF the field is populated; v1
  entries remain readable forever (back-compat preserved).
- **Four read-only MCP tools** — `list_specs`, `get_spec`,
  `get_spec_review`, `get_spec_verification`. NO write tools.
- **`shrk task --next` ranker insertion** — surfaces "verify spec X"
  as the highest-leverage action when a spec is `implementing`
  without a passing verification (between doctor blockers and
  stale-knowledge fixes).
- **`engine.feature-dev` pipeline** — gains optional `spec-create`
  prelude and `spec-verify` postlude steps (both `enabledWhen:
  'spec'`).

### Changed

- **`shrk start-here`** — PRIMARY_COMMANDS gains
  `shrk spec create` for discoverability.

### Safety contracts (unchanged)

- MCP never writes (no new write tools).
- No fake signing — `signPlan` / `verifyPlan` reused verbatim.
- `spec verify` runs only `trusted: true` verification commands.
- The engine never calls an LLM. Specs are written by humans /
  agents; the engine validates / grounds / executes them.

## [Unreleased] — R56: adaptive surface, project shape, diff-aware checks

R56 changes the underlying assumption: the visible surface is a
function of the project, not of the engine. A single-app repo sees
~10 commands; a 50-library monorepo sees the spine plus everything
its packs contribute. Same engine, different lens.

### Added

- **Surface tiers (`core` / `extended` / `experimental`)** —
  mechanically derived from a hardcoded bootstrap set + the spine
  pipelines + pack contributions + catalog overrides. Documented in
  `docs/surface-tiers.md`.
- **`shrk surface` verb** — `list`, `enable`, `disable`, `hide`,
  `unhide`, `reset`, `explain`. Preview-first; `--write` mutates
  `sharkcraft.config.ts surface{}`.
- **Structured "not enabled" error** — exit code 78, schema
  `sharkcraft.surface.not-enabled.v1`. Distinguishes "command
  exists but is gated" from "unknown command". Same shape returned
  on MCP.
- **Project shape auto-detection** — `single-app`,
  `app-with-libs`, `monorepo`, `library`, `unknown`. Cached at
  `.sharkcraft/shape.json`. Doctor prints a shape + surface
  totals line. Documented in `docs/project-shape.md`.
- **MCP tier gating** — every `CallTool` consults the same surface
  resolver as the CLI. Experimental tools return the structured
  error with `isError: true`. Bootstrap tools always pass through.
  `get_command_catalog` exposes a `tier` field per entry.
- **Diff-aware `--since <ref>` on `shrk lint`** — accepts a git
  ref, reports the changed-file count, runs whole-graph lints with
  a notice. `shrk check boundaries --since` already filtered
  violations (R28); R56 makes the wiring uniform via the new
  `packages/cli/src/diff/collect-changed-paths.ts` helper.
- **`shrk` (no args) lands on a curated tiered view** — project
  shape + surface totals + top-4 recommended commands. The
  exhaustive `--help` view remains for power users.
- **`shrk --about`** — in-binary philosophy summary.
- **Local usage log** — `.sharkcraft/usage/commands.jsonl`,
  schema `sharkcraft.usage.v1`. One entry per invocation. Flag
  NAMES only (never values). Opt-out via `usage: { enabled: false }`
  in `sharkcraft.config.ts` OR `SHARKCRAFT_USAGE_DISABLED=1` env.
  Rotates at 10MB. Foundation for R57's `surface --suggest-prune`.
- **Doctor JSON surface block** — `surface` and `shape` blocks
  alongside the existing fields. `summary.advisoryCount` directly
  exposed on `IDoctorResult` (R49 already collapsed in text).

### Changed

- `shrk` (no args) no longer routes to `--help`. The bare form is
  the curated landing; `--help` / `-h` continue to print the
  exhaustive view.
- `sharkcraft.config.ts` gains optional `surface?: { enabled[];
  hidden[] }` and `usage?: { enabled }` blocks. Existing configs
  validate unchanged.
- `.sharkcraft/usage/` and `.sharkcraft/shape.json` added to the
  managed `.gitignore` block.

### Deferred to R57+

- `@shrkcrft/angular-app` preset (R57 forcing function).
- `shrk surface --suggest-prune` (reads R56's usage log).
- `shrk knowledge propose`, `shrk schema list`, editor/LSP.

## [Unreleased] — R55: honest verdicts + agent ergonomics + smaller surface

R55 closes the concrete still-present issues from the third feedback in
`feedbacks.md`: real correctness bugs in exit-code logic, the catalog
truth gap, the templates-update metadata/array-merge gap, and the two
agent-facing primitives the feedback explicitly asked for (`task
--next` and `apply --batch`). The visible CLI surface shrinks by one
top-level group (`dashboard`).

### Added

- **`shrk task --next`** — surveys the workspace (doctor, knowledge
  stale, template drift, knowledge lint) and proposes ONE
  highest-leverage next action with the exact command to run.
  Deterministic priority order (documented in
  `docs/dev-workflow.md`). JSON shape stable as
  `sharkcraft.task-next/v1`. Pure ranker over existing JSON outputs
  — no new asset kinds, no AI.
- **`shrk apply --batch <plan>.json`** — multi-step fix-chain runner.
  Reads a JSON plan of fix steps (`action-hints` /
  `knowledge-stale` / `template-drift`), executes each via the
  existing apply path, fails closed on first refusal unless
  `--allow-divergent`. Each batch carries a deterministic content-
  hash `batchId` so a future history view can group provenance.
  Supports `--dry-run` for plan validation without spawning.
- **`commands doctor --json` verdict field** — JSON now includes a
  top-level `verdict: 'clean' | 'drift'` and a `strict` flag.
- **`commands doctor --strict`** — promotes warnings to failing
  status. Without --strict, only errors fail the verdict.
- **`templates update --apply` array merge modes** — `--add-tag`,
  `--remove-tag`, `--set-tags` (and parallels for `scope` /
  `applies-when` / `related`). `{ mode: 'add' | 'remove' | 'set',
  values }` shape in the applier; bare arrays remain back-compat
  alias for `set`.
- **`templates update --apply` metadata splicing** — nested upserts
  for known scalar fields (`priority`, `maturity`, `dryRunOnly`,
  `requiresApproval`) and known array fields (`requiredAnchors`,
  `requiredProfileIds`, `forbiddenPathFragments`,
  `requiredVerificationCommandIds`). Creates the metadata block on
  demand when absent.
- **knowledge-stale file/directory rename heuristic** — `replaceWith`
  now also fires for `kind: 'file'` and `kind: 'directory'`
  references when the basename matches exactly one candidate with
  ≥1 overlapping parent-directory segment. Ambiguous or unrelated
  namesakes still decline the rename and fall back to drop.
- **`audit project-coupling` per-flag rationale line** — text and
  markdown outputs explain which category the `--fail-on` exit code
  is gating on with the current count.
- **`ISafetyAuditDeepReport.infoOnlyFindings`** — count of
  info-level findings (typically dev-signed packs). Schema bumped
  to `sharkcraft.safety-audit-deep/v2`. The text rendering adds a
  rationale line when dev-signed packs are present so `passed: yes`
  alongside a non-empty dev list stops reading contradictory.

### Changed

- **`CouplingExternalizationTarget.Pack` → `.Engine`** — the bucket
  name now reflects the *source location* (in engine code, should
  be externalised) rather than the recommended target. Closes the
  user's mental-model mismatch from the third feedback.
- **`audit project-coupling --fail-on engine` exit code** — now
  category-specific: exits non-zero iff at least one hit has
  `externalizationTarget === 'engine'`. Pre-R55 it collapsed to
  `verdict === 'clean'`, which over-counted any high-risk hit.
- **`commands doctor`** — `unregistered-subcommand` and
  `missing-catalog-entry` promoted from `info` / `warning` to
  `error` severity, so the verdict matches reality. 3-level commands
  (e.g. `pack author status`) no longer trigger drift because the
  second token is an internal dispatcher, not a registered
  subcommand.
- **`shrk lint` JSON schema** → `sharkcraft.lint/v2`. The
  `knowledge.errors` field is gone (`KnowledgeLintSeverity` emits
  info / warning only; the hardcoded `0` was lying). Totals are
  derived from rules + templates errors.
- **`buildRenameSymbolPlan` schema** → `sharkcraft.knowledge-rename/v2`.
  `writePath` / `wrote` are gone (see Removed).
- **`shrk plan review` is now a registered subcommand** so the
  catalog and registry agree. The internal dispatcher in
  `planParentCommand` still works as a fallback.

### Removed

- **`shrk dashboard` (HTTP server)** —
  `packages/cli/src/commands/dashboard.command.ts` and
  `packages/cli/src/dashboard/dashboard-api-server.ts` are deleted
  along with their tests. No agent path, not in the spine. Read-only
  dashboard data is still available via the MCP `dashboard-summary`
  tool. Live dev sessions still use `live-session-server` via
  `shrk dev start`.
- **`shrk knowledge rename-symbol|rename-file|update-anchor --write`** —
  the patch-file output under `sharkcraft/knowledge-updates/` was
  inert (no consumer applied it). The verbs are now read-only
  preview. Use `shrk fix --knowledge-stale --apply` to land
  entry-side renames (R54/R55 emits `replaceWith` for the
  unambiguous cases).
- **R46 overlay entry `dashboard serve`** — removed alongside the
  command.
- **Catalog row `dashboard serve`** — replaced by an inline R55
  comment.

### Fixed

- **`insertField` (and the copy in `applyActionHintStub`)** — a
  latent bug stripped the closing `}` of the entry literal via
  `after.slice(range.indent.length)`. Existing tests only checked
  the inserted content's presence, so the broken generated TS went
  unnoticed. The fix preserves `after` verbatim; the inserted line
  ends with `\n + range.indent` so `}` re-lands on a properly
  indented line. Cascades to every `--apply` path that goes through
  the splicer.
- **Hardcoded `'pack'` strings in `audit.command.ts`** — switched to
  the renamed `'engine'` value so `--fail-on any` still works after
  the bucket rename.

### Notes

- Pre-existing `report *` variants (under `bundle`, `provenance`,
  `checks`, `biome`) and `bundle apply-assist --resume` were
  evaluated for pruning and kept: each is scoped to its own group
  with a documented consumer.
- `packages/dashboard` and `packages/dashboard-api` package
  directories were NOT deleted — separate web/api packages, not
  the CLI surface. A future round can revisit if they remain unused
  after the CLI removal.

## [Unreleased] — R54: rename-in-place + missing-barrel + prune

R54 closes only the high-value, low-risk items from the R53
next-round list per the reviewer's "less is more" stance. Symbol-
rename across source (would need a ts-morph AST pass), nested
metadata mutation, and a unified `lint --fix` were explicitly
deferred.

### Added

- **`replaceWith` on `IKnowledgeReferenceCheck`** in
  `@shrkcrft/inspector` — a structured `{ path | id | symbol;
  rationale }` payload. Emitted for `kind: 'symbol'` references when
  the symbol exists with the same name in exactly one other file
  under `packages/`. Ambiguous (multi-file) or absent (no file)
  candidates leave `replaceWith` undefined.
- **`shrk fix --knowledge-stale --apply` rename-in-place** — when a
  check carries `replaceWith`, the apply rewrites the reference's
  `path` / `id` / `symbol` field in place rather than dropping the
  element. Migration is the safe default; drops still require the
  explicit `--drop-stale` / `--drop-missing` flag. Provenance
  records `applied: 'rename' | 'drop'`.
- **`shrk fix --template-drift --apply` for `missing-barrel`** —
  creates the missing index file with a placeholder `export {};`
  body and `AUTO-CREATED` notice. The drift warning flips off
  because the file exists; the human populates the re-exports
  before the next drift run. Refuses pack targets and idempotent
  (refuses if the file already exists).

### Removed

- **`shrk watch`** and the `shrk watch integrity` subcommand. The
  individual commands all have `--watch` flags (R31): use `shrk
  doctor --watch`, `shrk lint --watch`, `shrk templates drift
  --watch`. Top-level reactive watcher was a thin wrapper that
  agents can't usefully consume.
- **`shrk doctor watch`** — 20-line trampoline that just forced
  `args.flags.watch = true`. Pure duplicate of `shrk doctor
  --watch`.
- `docs/watch-loops.md` (the only doc dedicated to these three).

### Preserved invariants

- No new MCP write tools.
- No fake-signing.
- `--apply` is preview-first; the `replaceWith` rename is strictly
  safer than the drop (no destructive default).
- No pack-source mutation from `--apply` paths.
- Layer order preserved.

## [Unreleased] — R53: apply parity + unified lint

### Added

- **`shrk fix --knowledge-stale --apply [--drop-stale] [--drop-missing]`** —
  in-place removal of the offending reference from the entry's
  `references[]` array. Preview-first, refuses pack-contributed
  sources, records provenance.
- **`shrk fix --template-drift --apply`** — in-place fix for
  `related-id-unresolved` (drops the unresolved id from the
  template's `related[]` array). Other drift codes stay preview-only
  (body issues require editing the `files()` resolver).
- **`shrk templates update --apply`** — splices the projected
  metadata fields (`name` / `description` / `tags` / `scope` /
  `appliesWhen` / `related`) into the existing template literal in
  place. Refuses pack-contributed templates and function-resolver
  replacement.
- **`shrk lint`** — unified lint aggregator over knowledge / rules /
  templates. `--kind`, `--strict`, `--fix-preview`, `--json`. Pure
  CLI aggregator; no new domain logic. Full surface in
  [docs/lint.md](./docs/lint.md).
- **Shared entry-aware mutator** at
  `packages/cli/src/asset-preview/entry-mutator.ts` — `findEntryRange`
  (extracted from the R52 action-hint splicer), `replaceScalarField`,
  `upsertScalarField`, `insertField`, `removeArrayEntries`,
  `removeStringFromArray`, `splitTopLevelCommas`. All three R53
  splicers consume these primitives.

### Preserved invariants

- No new MCP write tools.
- `--apply` is preview-first; refused targets block the whole apply
  unless `--allow-divergent` is set.
- No pack-source mutation from any CLI `--apply` path.
- All write paths record provenance to
  `.sharkcraft/asset-provenance.jsonl`.

## [Unreleased] — R52: authoring symmetry + doctor blockers + release handoff

### Added

- **`shrk rules add` / `shrk rules remove`** — authoring parity for
  rules. `rules add` forces `type='rule'` and delegates to the
  `knowledge add` pipeline (same preview path, same provenance).
  `rules remove` asserts the target id is a rule and refuses
  non-matching ids before delegating to `knowledge remove`.
- **`shrk templates update` / `shrk templates remove`** — authoring
  parity for templates. Drafts land under
  `.sharkcraft/authoring/templates/`. `remove` performs reverse-
  reference checking against pipelines, presets, knowledge entries
  (`references[kind=template]`), and pack-contributed template files;
  refuses unless `--force-preview` is set.
- **`shrk fix --action-hints --apply`** — splice stubbed `actionHints`
  blocks into the matching entries in `sharkcraft/knowledge.ts`.
  Preview-first under the hood; refuses on divergence unless
  `--allow-divergent`; refuses pack-source targets; records
  provenance per applied stub.
- **`shrk doctor --blockers`** — must-fix view in one flag. Composes
  with `--json` and `--watch`. Exit 0 iff zero blockers remain. Full
  definition in [docs/doctor.md](./docs/doctor.md).
- **`shrk packs signature-status --release-readiness`** — per-pack
  annotation of whether the current signature would block
  `release:preflight` (dev signature + missing
  `SHARKCRAFT_PACK_SECRET` = blocking).
- **`shrk release readiness` fail-closed on dev signatures** — emits a
  new `pack-signature-release` blocker when any pack is dev-signed and
  `SHARKCRAFT_PACK_SECRET` is unset. Downgrades to a warning when the
  secret is available (re-sign before tagging).
- **`shrk safety audit --deep` dev-signature line** — enumerates
  dev-signed packs in the deep-audit output (severity = `info`).

### Changed

- **Shared CLI authoring kit** at `packages/cli/src/authoring/` —
  extracted `detectAuthoringSource`, `writeAuthoringDrafts`,
  `multiFlagValues`, `parseReferenceSpec`. Knowledge / rules /
  templates authoring commands all import from the same module
  instead of duplicating the helpers.
- **`buildPackSignatureReleaseGate`** in `@shrkcrft/inspector` —
  extracted as a standalone gate so tests can exercise the
  dev-signature blocking logic without spinning up the full
  release-readiness pipeline.

### Preserved invariants

- No new MCP write tools. The action-hint apply lives on the CLI
  only.
- No fake-signing. `release:preflight` never auto-re-signs; it fails
  closed and prints the exact `shrk packs sign <pack>` command
  needed.
- No pack-source mutation from `--apply`. Pack-contributed entries
  are refused; users edit the pack source and re-sign explicitly.
- All write paths record provenance to
  `.sharkcraft/asset-provenance.jsonl`.

## [Unreleased] — R51: bounded loader + inspector cache

### Added

- **`safeImport` / `IImportContext`** in `@shrkcrft/core` — bounded
  `await import()` with a configurable per-asset timeout and an
  optional per-process dedup wrapper. Replaces every raw
  `await import()` in knowledge / templates / pipelines / presets /
  boundary loaders. A failed TS asset can no longer hang the host
  process by re-importing on a second call.
- **`createInspectorCache`** in `@shrkcrft/inspector` — persistent
  loader cache under `.sharkcraft/cache/inspector/v1/`. Entries are
  fingerprinted by path + mtime + size + sha256-prefix, store the last
  load status (`ok` / `failed` / `timeout`) and elapsed ms. A
  previously-failed asset is **skipped** on the next inspect (cached-
  skip) without re-triggering the import — that is the killer feature
  that stops a single broken pack file from breaking every subsequent
  command.
- **Per-loader diagnostics**: `ISharkcraftInspection.loaderDiagnostics`
  reports kind, origin, pack name, elapsed ms, status, count, warning
  count, large-file flag, slow flag, error message, and a suggested
  next command for any failure or slow loader.
- **CLI flags** on `shrk inspect` and `shrk doctor`:
  `--debug` surfaces the loader-timing table; `--no-cache` bypasses
  the persistent cache; `--loader-timeout <ms>` overrides the default
  8000ms per-asset bound.
- **Doctor errors** for any loader failure / timeout, with a `fix:`
  hint pointing at the right follow-up command — failed pack assets
  are now loud, not silent.
- **Unquarantined**: the 12 adopter-keyed inspector tests R50
  quarantined now run automatically whenever a sibling adopter
  checkout is present, with an opt-out env var for CI environments
  without one.

### Fixed

- **Adopter inspect hang** — every `shrk --cwd <adopter> ...` command
  (inspect, doctor, templates list, packs contributions, gen
  --dry-run, etc.) would either hang indefinitely or exit 0 with no
  output. Root cause: Bun's dynamic `import()` returns a never-
  resolving promise on the second import of a TS file whose first
  import rejected at parse time. A duplicate
  `export const noReexportProxy` declaration in an adopter pack's
  rules file was the trigger. R51 bounds every loader call with a
  timeout, dedups path-keyed imports for the duration of an
  inspection. Smoke results: all adopter commands return in 400–600ms
  with exit 0; the previously broken contribution surfaces as a
  clean doctor error.

### Changed

- `inspectSharkcraft({useCache})` defaults to **false** so MCP tools
  remain strictly read-only. CLI commands opt in to the cache.
- All built-in TS loaders (knowledge / templates / pipelines /
  presets / boundaries) accept an optional `{importContext}` second
  argument. The inspector creates one context per call; standalone
  callers fall back to a fresh `safeImport` (still bounded by the
  default 8000ms timeout).

## [Unreleased] — R47: universal adoption top-5

### Added

- **`shrk inspect`** now prints a structured **Detected** block:
  workspace flavor (Nx / Turborepo / workspaces / single package),
  package manager, frameworks, source / test / package / generated
  roots, build / test / typecheck / lint / start script names,
  ESLint / Biome / GitHub Actions / nx / turbo config presence, the
  recommended preset (top-1 from `recommendPresets()`), and an
  honest "not guessed" list. Same block is echoed by
  `shrk init --zero-config` so the user sees what zero-config init
  would do before opting into `--write`.
- **`shrk inspect --no-config`** and **`shrk doctor --no-config`** —
  graceful no-sharkcraft-folder mode. The verdict line is advisory
  and the exit code stays 0; the user is pointed at
  `shrk init --zero-config` as the next step.
- **Two canonical preset aliases**: `nest-service` (composes
  `nestjs-service`) and `angular-app` (composes `modern-angular`).
  Both surfaced via `shrk presets list` and pick-able by
  `shrk init --preset auto` for matching repos.
- **`shrk presets explain <id>`** — natural-language "when to use
  this preset" view with the composition chain, `appliesTo`
  translation, asset counts, and a "for this repo: rank N of M" line
  driven by `recommendPresets()`.
- **`shrk eslint rules`** — read-only inventory classifying every
  SharkCraft rule / path / boundary / check as **bridgeable** /
  **adjacent** / **not-bridgeable**.
- **`shrk eslint explain-limitations`** — prints the honest list of
  what cannot be bridged (plan signing, pack signatures, knowledge
  stale-check, template drift, self-config doctor) and what to keep
  in CI.
- **`shrk biome report`** — adjacent (not native) Biome diagnostics
  JSON converted from `shrk check boundaries --json`. Documented as
  adjacent in `biome explain-limitations`.
- **`shrk biome explain-limitations`** — Biome-specific bridge
  limitations.
- **`shrk eslint config` / `shrk biome config`** aliases for the
  respective `scaffold` verbs (the names match feature_47.md's
  preferred shape).
- **`sharkcraft.check-result/v1`** + **`sharkcraft.check-aggregate/v1`** —
  the universal check-result protocol. `findings` carry severity /
  file / line / column / ruleId / message / suggestedAction /
  safeToAutoFix. See `docs/check-result-protocol.md`.
- **`shrk checks import <file>`** — read a v1 report or auto-convert
  ESLint / Biome JSON and store it under `.sharkcraft/checks/`.
- **`shrk checks aggregate`** — rolls every imported result into a
  single `sharkcraft.check-aggregate/v1` payload (worst-wins status).
- **`shrk checks report [--format text|markdown|json]`** — render
  the rollup (or each individual result if no rollup exists).
- **`shrk checks convert eslint|biome <file>`** — one-shot
  conversion to v1; prints to stdout or writes to disk.
- **`shrk ci scaffold github-actions --quickstart`** dry-run output
  now labels **exact path**, **next command**, and an
  **Explanation of gates** block listing every step's purpose +
  whether it was enabled by detection or by an explicit flag.
- **Recommender miss penalty (−3 per missing `appliesTo` profile)** —
  prevents more-specific presets (e.g. `next-app: [HasNext, HasReact,
  IsFrontend]`) from outranking more-targeted ones (`react-app:
  [HasReact, IsFrontend]`) on partial-match repos.
- **Five `examples/adoption-*` fixtures** — `typescript-library`,
  `react-app`, `next-app`, `nest-service`, `nx-monorepo`. Each one
  pins a canonical-stack auto-pick.
- **Docs**: `docs/zero-config-init.md`, `docs/eslint-bridge.md`,
  `docs/biome-bridge.md`, `docs/github-action.md`,
  `docs/check-result-protocol.md`. Updates to `docs/start-here.md`,
  `docs/presets.md`, `docs/safety-model.md`.

### Constraints honored

- **No new MCP write tools.** R47 added no MCP tools.
- **No fake signing.** `packs signature-status` still surfaces stale
  signatures with the manual re-sign instruction.
- **No project-specific logic in engine.** `migrate project-coupling
  audit` engine-clean.
- **No changes under adopter source.** Verified by `git status` in
  the adopter checkout.
- **TS/JS first-class.** Every new surface ships in TS and only
  enriches the TS adoption story; the polyglot surfaces stay
  unchanged.

## [Unreleased] — R44: agent-friendly pack authoring and knowledge lifecycle

### Added

- **`shrk knowledge add | update | remove`** — structured, preview-only
  authoring of knowledge entries. Drafts land under
  `.sharkcraft/authoring/<op>-<id>.{draft.ts,manifest.json,md}`. Never
  mutates `sharkcraft/knowledge.ts` or pack source. `update` preserves
  unspecified fields (including arbitrary `metadata.*`). `remove`
  reports reverse references and refuses by default — prefers a
  deprecation suggestion (`--mark-deprecated`) over deletion; explicit
  `--force-preview` is required to preview deletion when referenced.
- **`shrk knowledge lint [--fix-preview]`** — classifies findings as
  `safe-mechanical-stub` / `needs-human-wording` / `should-acknowledge` /
  `obsolete-entry` / `stale-reference` / `missing-provenance` /
  `missing-action-hints`. Never fabricates prose — safe stubs carry
  explicit `TODO(field):` markers. `--fix-preview` partitions findings
  into safe stubs vs. TODOs vs. acknowledgements.
- **`shrk pack-author status | preview | pending | validate`** (alias:
  `shrk pack author <verb>`) — pack asset authoring workflow.
  Knowledge is the implemented kind in R44; the other 7 kinds
  (search-tuning, feedback-rule, agent-test, convention,
  task-routing-hint, registration-hint, scaffold-pattern) return an
  honest deferral with the right next-command list. Status surfaces
  contribution counts per kind, pending drafts, provenance ledger
  presence, and `SHARKCRAFT_PACK_SECRET` availability.
- **`shrk packs pending`** — alias for `shrk pack-author pending`. The
  combined pending view: modified pack asset files, drafts under
  `.sharkcraft/authoring/`, stale signature state, pending provenance,
  missing-secret guidance. Writes a signing TODO with
  `--write-todo`. Never signs.
- **Asset provenance ledger** — `.sharkcraft/asset-provenance.jsonl`.
  Append-only, local-only, JSONL. Recorded automatically by
  `shrk knowledge add/update/remove --write-preview`. Refuses to write
  outside `.sharkcraft/`. No telemetry.
- **`shrk provenance list | show | report`** — query the ledger.
  Auto-detects source (`agent` / `cli`) from environment
  (`SHARKCRAFT_AGENT`, `CLAUDE_CODE_SESSION`, `ANTHROPIC_AGENT`); honours
  `$SHARKCRAFT_AUTHOR` / `$USER` for the `author` field.
- **Adopter pack template gap closure** — three new pack-only templates
  in `tools/sharkcraft-pack/src/assets/templates.ts`. Each emits a
  preview targetPath under `.sharkcraft/preview/<template-id>/` until
  the canonical adopter path is confirmed.
- **Knowledge-authoring dogfood** — a representative knowledge entry
  was authored end-to-end via `shrk knowledge add --write-preview`
  against an adopter codebase, validating the loop on a real entry.
  **No source under the adopter checkout was modified.**

### Changed

- `IDoctorCheck` rendering, `shrk packs signature-status`, and the
  existing R43 surfaces are unchanged. R44 strictly *adds* surfaces.
- `pack-signatures.md`, `safety-model.md` updated to document the
  combined pending view + the new authoring write surfaces.

### Schemas added

- `sharkcraft.knowledge-authoring/v1`
- `sharkcraft.knowledge-authoring-patch/v1`
- `sharkcraft.knowledge-lint/v1`
- `sharkcraft.knowledge-lint-fix-preview/v1`
- `sharkcraft.pack-author-status/v1`
- `sharkcraft.pack-author-preview/v1`
- `sharkcraft.pack-author-validate/v1`
- `sharkcraft.pack-pending/v1`
- `sharkcraft.asset-provenance/v1`
- `sharkcraft.asset-provenance-report/v1`

### Hard rules respected

- No new MCP write tools.
- No fake signing.
- No weakening of the safety audit.
- No project-specific logic in the SharkCraft engine.
- No changes under adopter source.
- Default behavior is preview-only on every new command.
- All generated drafts / patches live under `.sharkcraft/`.
- Tests cover every new public surface (40+ new tests across
  `packages/inspector/src/__tests__/r44-authoring-tooling.test.ts` and
  `packages/cli/src/__tests__/r44-cli-surfaces.test.ts`).

### Docs added

- `docs/knowledge-authoring.md`
- `docs/pack-authoring-workflow.md`
- `docs/asset-provenance.md`
- `docs/pack-signatures.md` — R44 combined pending section
- `docs/safety-model.md` — R44 authoring loop section
- `.sharkcraft/reports/r44-existing-surface-audit.md` (the Part 0 audit
  that drove this round)
- `.sharkcraft/reports/r44-final-report.md` (the round summary)

## [Unreleased] — R43: rule authoring, shape checks, codemod-assist, signature UX, warning quality

### Added

- **`shrk rules scaffold`** — emits a structured rule preview under
  `.sharkcraft/fixes/rule-<id>.preview.{ts,json,md}`. Preview-only by
  default; `--write-preview` materialises the three files. Knows the
  schema fields the agent must fill (`id`, `title`, `priority`, `scope`,
  `tags`, `appliesWhen`, `forbiddenActions`, `verificationCommands`,
  `examples`, `source.origin`, `metadata.advisory`). Kinds:
  `architecture | safety | style | governance | migration | testing | advisory`.
- **`shrk rules doctor`** — per-rule quality findings beyond the existing
  action-hint diagnostics: `vague-rule`, `missing-examples` (style /
  shape rules), `missing-owner`, `advisory-not-marked`,
  `advisory-has-unused-verification`,
  `verification-references-unknown-script`. Advisory rules (`metadata.advisory: true`)
  opt out of the verification axis.
- **`shrk checks list | doctor | run | parse-report`** — custom-check
  registry. Rules declare deterministic external checks via
  `metadata.checks: ICustomCheckDescriptor[]`. The engine never runs a
  command unless `--execute` is set explicitly. JSON report convention:
  `sharkcraft.custom-check/v1` (also accepts text fallback /
  exit-code-only).
- **`shrk codemod inventory | plan | checklist --rule <id>`** — codemod
  *assist*, **not** a codemod engine. Reads a custom-check report,
  groups affected files by risk (low/medium/high) using consumer counts,
  recommends an external tool (ts-morph / jscodeshift / eslint custom),
  and emits a project-script template under `.sharkcraft/fixes/`. The
  engine never rewrites source.
- **`shrk packs sign --if-needed | --check-only | --print-command | --write-todo`** —
  agent-friendly signing UX. Honest about missing `SHARKCRAFT_PACK_SECRET`
  (no fake signing); writes a signing TODO under `.sharkcraft/reports/`
  when `--write-todo` is set.
- **`shrk packs doctor --signature-explain`** — per-pack lifecycle states
  (`valid | unsigned | stale | invalid | secret-missing | not-required | unknown`),
  with a one-line explanation and the exact next command per pack.
- **`shrk doctor --explain-quality`** — surfaces the new
  `whyThisMatters` line on every action-hint warning so warnings stop
  becoming permanent yellow noise. Every action-hint warning also now
  carries `category`, `code`, and `recommendedFix`.
- **Adopter dogfood report** — the no-reexport-proxy workflow was
  walked end-to-end against a live adopter codebase. **No source
  under the adopter checkout was modified.**

### Changed

- `IDoctorCheck` extended with optional fields (`category`, `code`,
  `recommendedFix`, `whyThisMatters`, `advisory`). Backwards compatible
  — all fields optional.
- `actionHints`-derived doctor warnings carry the new fields by default,
  driving consistent renderer behaviour across `shrk doctor`,
  `shrk fix preview`, and `shrk rules doctor`.

### Hard non-goals (kept)

- No new MCP write tools.
- No fake pack signing.
- No weakening of the safety audit.
- No project-specific logic in engine packages.
- No source rewrite in `shrk codemod` (engine assists; rewrites stay external).

### Docs

- `docs/rule-authoring.md` (new) — scaffolding flow + schema cheatsheet.
- `docs/custom-checks.md` (new) — descriptor model + JSON report convention.
- `docs/codemod-assist.md` (new) — what the engine does and does NOT do.
- `docs/doctor-warning-quality.md` (new) — fields, render order, suppression.
- `docs/pack-signatures.md` (existing) — refreshed with R43 flags.
- `docs/safety-model.md` (existing) — confirms R43 honours every pillar.

## [Unreleased] — R41: command surface consolidation, product UX polish

### Added

- **Command-catalog R41 metadata.** `ICommandCatalogEntry` now carries
  optional `surface` (Primary | Common | Advanced | Machine | Internal |
  Legacy), `intendedAudience` (Human | Agent | CI | PackAuthor |
  Maintainer), `taskRole` (Start | Context | Search | Explain | Generate
  | Review | Validate | Release | Diagnose | Inspect), `preferredCommand`,
  `overlapsWith`, `replacedBy`, and `machineOnly`. Helper accessors
  (`commandSurface`, `commandAudience`, `commandTaskRole`,
  `commandUseWhen`) derive defaults from existing fields.
- **New `shrk commands` views** — no new top-level family:
  - `shrk commands surface [<primary|common|advanced|machine|internal|legacy>]`
  - `shrk commands machine` / `shrk commands legacy` / `shrk commands overlaps`
  - `shrk commands explain <cmd>` enriched with surface / audience /
    role / preferredCommand / overlapsWith / "Use this when…" block.
- **`docs/command-entrypoints.md`** — one-page canonical answer to
  "which command should I run first?".
- **`shrk commands ux-check` R41 checks** — `primary-without-audience`,
  `primary-without-role`, `machine-marked-primary`,
  `legacy-without-replacement`, `overlap-without-preferred`,
  `description-without-purpose`, `too-many-primary-for-role` (warnings).

### Changed

- **Shorter default human output.** `shrk recommend`, `shrk context
  --task`, `shrk task`, `shrk search`, and `shrk doctor` text modes
  default to verdict + top 3–5 items + next command + a one-line
  pointer to detail. `--verbose` / `--full` keep the long form. JSON /
  markdown / commands-first paths are untouched.
- **Banner wording aligned with R41 canonical-entrypoint message.**
  `entrypointBanner('recommend' | 'context' | 'task' | 'search' | 'why')`
  point operators back at `shrk recommend` for "what should I do?".
- **MCP descriptions.** `prepare_agent_task` is now explicit about
  being the canonical first call; `get_task_packet` and
  `get_relevant_context` defer to it.

### Notes

- No new MCP write tools. No changes under adopter source. R41 is
  pure consolidation — no command was renamed or removed.
- Release-preflight + 1248-test suite green.

## R38: connective tissue, self-policing, noise reduction

### Added

- **Self-config doctor v2** (`sharkcraft.self-config-doctor/v2`). Same
  `shrk self-config doctor` surface, now defaults to v2; pass
  `--schema v1` for the legacy shape. Adds cross-reference checks for
  agent-tests → helpers / playbooks / policies / commands, policies →
  rules / commands / paths, pipelines → templates / commands,
  playbooks → templates / pipelines, registration hints → templates /
  conventions / profiles, and decisions → rules / policies / files.
  Each finding carries `sourceKind / sourceId / targetKind / targetId /
  relation / file / message / suggestedFix / nextCommand / confidence`.
- **Doctor acknowledgements** layered on top of the R29 suppressions.
  - `shrk doctor acknowledge --id|--code|--category --reason "<text>" --expires-in 7d`
    writes a typed acknowledgement to
    `sharkcraft/doctor.suppressions.json`. Empty / TODO-prefixed
    reasons are rejected; missing expiry is rejected.
  - `shrk doctor acknowledgements list|check` lists / validates.
  - `shrk doctor --hide-acknowledged` shows only acknowledged entries.
  - `shrk doctor --fail-on-expired-acknowledgement` exits non-zero
    when any acknowledgement expired.
- **Import hygiene allowlist generator**:
  `shrk check imports --emit-allowlist <file> [--emit-allowlist-kind …]
  [--only-allowlist-candidates] [--fail-on-unexplained-allowlist]`.
  Draft entries carry a `TODO:` reason placeholder; strict mode
  refuses to apply allowlist entries whose reason is still TODO.
- **Apply dispatch trace** (`sharkcraft.apply-dispatch-trace/v1`).
  `shrk apply <plan> --trace` / `--explain-dispatch` and
  `shrk plan review <plan> --trace-dispatch`. Trace describes dispatch
  kind, op counts, plan-v2 operation kinds, signature status, safety
  gates, required flags, and final action.
- **Changed-only preflight orchestrator** —
  `shrk preflight [--since <ref>|--staged|--files a,b,c] [--profile quick|standard|strict] [--explain] [--json]`.
  Pure planner picks read-only gates from the changed-file shape;
  CLI runs the `Run` gates and surfaces `Recommend`.
- **Entrypoint matrix** — `shrk commands entrypoints` (alias:
  `shrk commands workflows`) renders four classes (human-interactive
  / agent-mcp / machine-json / debug-explainability). One-line
  entrypoint banners on `shrk task` / `shrk context` / `shrk recommend`.

### Changed

- **Pack contributions inventory** — new
  `buildPackContributionsInventoryAsync(inspection)` does
  structural-first extraction via the dedicated registries; regex
  fallback dedupes against `(kind, packageName||local, id)` so the
  same logical contribution doesn't double-count when reachable from
  multiple paths. Adopter inventory: 122 conflicts → 111 (11 errors → 0).
- **`shrk self-config doctor`** defaults to v2; `--schema v1` for the
  legacy shape.
- **`sharkcraft/rules.ts`** gets `writePolicy: 'cli-only'` on
  `repo.architecture.respect-layer-order`,
  `repo.discovery.read-examples-first` (also added
  `verificationCommands`), and `repo.testing.bun-only`. Clears all
  four long-standing action-hint quality warnings.
- **CLI command catalog** gains a `preflight` entry.

### Tests

- `packages/inspector/src/__tests__/r38-connective-tissue.test.ts` —
  22 deterministic tests covering acknowledgements, allowlist draft,
  strict-reasons, dispatch trace classifications, preflight planner,
  entrypoint matrix, and the engine-coupling regression guard.
- Full suite: **1200 / 1200 pass** (was 1178; +22).

### Safety / MCP / coupling

- No new MCP tools. No new write paths.
- `shrk safety audit --deep` passes.
- `shrk migrate project-coupling audit --fail-on engine` returns clean.
- Engine package scan returns no project-specific matches outside `__tests__`.

### Dogfood

- `shrk doctor` — 0 errors / 179 pack-rule warnings / 7 ok.
- `shrk self-config doctor` — 0 errors / 1 stale-signature warning / 8 info.
- `shrk check boundaries --changed-only` clean on 120 changed files.
- `shrk packs contributions` — 563 entries / 0 conflict-errors.
- Adopter source untouched.

### Reports

- `.sharkcraft/reports/r38-existing-surface-audit.md`
- `.sharkcraft/reports/r38-doctor-warning-fatigue.md`
- `.sharkcraft/reports/r38-import-hygiene-allowlist.md`
- `.sharkcraft/reports/r38-apply-dispatch-trace.md`
- `.sharkcraft/reports/r38-pack-inventory-v2.md`
- `.sharkcraft/reports/r38-changed-preflight.md`
- `.sharkcraft/reports/r38-entrypoint-clarity.md`
- `.sharkcraft/reports/r38-final-report.md`

## [Unreleased] — R37: import-hygiene strictness + lazy `require('node:*')` ban

### Changed

- **`require('node:*')` is now an `error`-severity finding** (was `warning` in R36). Node built-ins are resolved before any user code runs; lazy-loading them buys nothing and the customary `as typeof import('node:fs')` cast is a hack to satisfy strict TS where a top-level `import` would have typed the call for free. The `runtime-require` finding kind now reports `error` regardless of whether the spec starts with `node:`. The allowlist (with a required `reason`) remains the only legitimate escape hatch.
- **Engine-wide cleanup** — 23 production-code sites and 14 test sites previously used `const { ... } = require('node:fs') as typeof import('node:fs');` (or similar for `node:path`, `node:os`, `node:crypto`, `node:child_process`, `node:url`). All replaced with top-level ESM imports. The single retained `require('node:fs')` substring lives inside a *string-literal* test fixture in `r36-reliability-hardening.test.ts:72`.
- **Doctor comment** in `import-hygiene.ts` rewritten to explain the new policy in-line.
- **suggestedFix** text for `runtime-require` updated to explain that built-ins gain nothing from lazy require.

### Added

- **`repo.imports.no-lazy-node-builtin-require` rule** in `sharkcraft/rules.ts` (priority: `critical`). Documents the policy, lists forbidden actions, and pins `shrk check imports` as the verification command. Surfaces via `shrk context` / `shrk task` / `shrk recommend` so agents see the rule where they work. Knowledge entries count: **45 → 46**. AI-readiness: **72 → 73**.
- **`import-hygiene` preflight gate** — `scripts/release-preflight.ts` adds a new **required** step between `typecheck` and `tests` that runs `shrk check imports`. Any new lazy `require('./x')` or `require('node:fs')` blocks the release chain. Read-only; never writes.
- **`development/feature_37.md`** — round prompt file with the SKILL.md reference and the full task body (per the prompt-as-file contract).

### Tests

- `r37-no-lazy-node-builtin.test.ts` — 5 deterministic tests:
  - `require('node:fs')` is now `error`-severity (R37 policy).
  - Every Node builtin spec (`node:path`, `node:crypto`, …) flagged the same way.
  - Allowlist with documented `reason` still downgrades to `info`.
  - **Engine-wide regression guard**: `buildImportHygieneReport` against the actual repo returns **zero** `runtime-require` × `error` findings.
  - The `repo.imports.no-lazy-node-builtin-require` rule is loaded with the correct shape (priority, verification command, forbidden-action list).
- `r36-reliability-hardening.test.ts` — one existing assertion updated (`require(node:*)` is now expected at `error` severity, not `warning`).
- Overall test count: **1178 / 1178 pass** (was 1173; added 5 R37 tests).

### Safety / MCP

- No new MCP tools (read-only or otherwise).
- No new write paths; `shrk check imports` is read-only.
- No adopter source modifications.
- No fake signing.
- `shrk safety audit --deep` passes.

### Migration notes

- Local packs that previously contained `require('node:*')` patterns should convert to top-level imports. The checker will surface every such site under `shrk check imports`. If a particular usage is genuinely intentional (cold-path code-splitting on a non-builtin module), add an allowlist entry with a sentence-long `reason`. **Do not add allowlist entries for `node:*` builtins** — there is no legitimate reason.

## R36: reliability / hardening / structural cleanup

### Added

- **Import hygiene checker** — `shrk check imports` / `shrk check import-hygiene` (with `--changed-only` and `--since` scoping). Schema `sharkcraft.import-hygiene/v1`. Flags inline `import('./x').Type`, runtime `require('./x')`, and dynamic `import('./x')` in normal engine source. Allowlist file at `sharkcraft/import-hygiene.allowlist.json` (each entry carries a required `reason`). Built-in `require('node:*')` is downgraded to a warning (Node builtin lazy-load, distinct from cross-module require hiding). `typeof import('x')` type expressions are NOT flagged.
- **Helper plan saved-plan pipeline** — `shrk helper plan <id> --save-plan <file> [--sign]` now emits a synthetic plan (`templateId: __helper__`, schema `sharkcraft.plan/v2`) that flows through `shrk apply --verify-signature` via the R35 synthetic-plan dispatch.
- **Registration hint saved-plan pipeline** — `shrk registrations plan <id> [--target <file>] [--var k=v] [--save-plan <file>] [--sign]`. Ambiguous discovery is refused (must pass `--target` when multiple candidates match). Missing target → conflict. Synthetic `templateId: __registration-hint__`.

### Changed

- **`agent-handoff.ts` import hygiene** — the inline `import('./uncertainty-report.ts').IUncertaintyReport` type annotation and the matching `require('./uncertainty-report.ts')` call inside `buildHandoffUncertainty` were structural escape hatches around a non-existent circular dependency. Both replaced with a normal top-level `import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';`. Same fix applied to `pr-summary.ts`, `ci-predict.ts`, and `scaffold-coverage.ts`.
- **`file-change.ts` ↔ `planned-change.ts` cycle** — was hidden by an inline `import('./planned-change.ts').IPlannedOperation`; now uses a normal `import type` (TS erases type-only imports at compile time, so circular type-only edges don't cause runtime issues).
- **Plugin rename word-boundary** (R35 limitation #1 closed) — `buildPluginRenamePlan` no longer uses `content.includes(\`segment/oldName\`)` for barrel-line matching. New `segmentBoundaryRegex(segment, name)` requires a non-identifier character (kebab `-`, underscore `_`, alphanumeric, dot) after the name, so `data` does NOT match inside `dataflow`, `data-flow`, or `data.foo`. Saved plans for shared-prefix plugin names no longer emit spurious no-op replaces.
- **Multi-op-per-path plan divergence** (R35 limitation #2 closed) — `diffPlanChanges` now keys by `relativePath::operation-fingerprint` (stable canonical hash of the operation intent). Multiple ops on the same file are tracked independently. Same-path entries that don't fingerprint-match fall back to type-changed / operation-changed / removed diagnostics for a useful message. Backward-compatible for v1 plans (uses `legacy:<type>` fingerprint).
- **Pack contributions inventory noise reduction** (R35 limitation #3 mostly closed) — `IContributionEntry` now carries `extractionMode: 'structural' | 'regex-fallback' | 'file-only'` and `confidence`. Conflicts where all participating entries are same-file `regex-fallback` are downgraded from `error` to `info` (these are almost certainly nested `step.id` / `anchor.id` fields, not real top-level duplicates). Adopter dogfood: **19 false-positive errors → 19 info**.
- **Helper-registry runtime requires removed** — `test-runner.ts`, `fuzzy-impact.ts`, `knowledge-stale.ts`, and `query-resolver.ts` previously used `require('./helper-registry.ts')` as a circular-dep escape hatch. No cycle existed; all converted to normal top-level imports.
- **Registration hint glob resolver** — fixed a `nothing to repeat` regex bug when the glob contained `**` followed by a literal path. Now correctly converts globs to anchor-based regex even for multi-star patterns. Malformed globs are skipped silently instead of crashing.

### Safety / MCP

- No new MCP write tools. No MCP additions at all this round.
- `shrk safety audit --deep` passes.
- Project-coupling audit clean on engine packages.
- All write-capable CLI behavior continues to require explicit allow flags + safety preflight.

### Tests

- `r36-reliability-hardening.test.ts` — 11 deterministic tests across import hygiene (6 tests), multi-op plan diff (2 tests), helper plan conversion, plugin rename word-boundary, and the agent-handoff regression guard.
- Overall test count: **1173 / 1173 pass** (was 1162 in R35 — added 11).

### Migration notes

- Templates / packs adopting the new word-boundary rename should keep their existing profile/conventions; no manifest changes required.
- Helper plans now have two output modes: legacy helper-plan JSON (`--output`) and saved plan (`--save-plan`). The latter is the apply-ready path.
- Registration hint authors should populate `targetGlobs[]` for discovery; ambiguous-target preview is now `error` at plan time, not silent guess.

## [Unreleased] — R35: apply pipeline integration, source operation primitives, anchors, registration hints, uncertainty everywhere, pack reliability

### Added

- **Apply pipeline carries folder ops** — `ISavedPlan.folderOps[]?` is signed by HMAC alongside `expectedChanges[]`. `shrk apply` now runs folder safety preflight, refuses unsafe paths before any FS write, requires `--allow-folder-ops` (+ `--allow-delete-folder` for delete-folder), and executes via `applyFolderOps()` after files. New exit categories `blocked-folder-op-allow-flag` / `blocked-folder-op-unsafe`. Plan review surfaces folder ops with safety verdicts. `shrk plugin rename/remove --save-plan <file>` produces synthetic plans (`templateId: __plugin-lifecycle__`) applicable through the standard apply path.
- **Plan-v2 source operation primitives** — `ensure-import` (with type-only, default, namespace, and named-symbol merge), `insert-enum-entry`, `insert-object-entry`, `insert-before-closing-brace`, `insert-between-anchors`. All deterministic, idempotent, anchor-bounded. Line-bounded matching prevents substring false-positives between anchors like `// region:body` and `// region:body:end`.
- **Template anchor metadata + drift verification** — `template.metadata.producedAnchors[]` / `requiredAnchors[]`. `template-drift` cross-checks anchor producers against consumers and surfaces `missing-produced-anchor` / `missing-required-anchor` / `produced-anchor-target-missing` issues.
- **Registration hints** — new pack contribution kind `registrationHintFiles[]`. `IRegistrationHint` describes a downstream registration step (composer wiring, route entry, capability registration, etc.) without the engine knowing project-specific paths. CLI: `shrk registrations list|get|doctor|preview`. MCP: `list_registration_hints`, `get_registration_hint`, `preview_registration_hint` (all read-only). Ambiguous discovery refused — preview reports `ambiguous: true` rather than guessing.
- **Synthetic plan dispatch** — `evaluateSavedPlanInPlace` + `writeSyntheticPlan` in `@shrkcrft/generator`. Apply recognises `__`-prefixed templateIds, skips template lookup, and evaluates saved ops against the live file system. Used by plugin lifecycle.
- **Uncertainty wired everywhere** — `IUncertaintyReport` now surfaces on `shrk recommend`, `shrk ci predict`, `shrk pr summary`, `shrk handoff`, and `shrk coverage scaffolds`. Generic builder `buildUncertaintyReport()` for surfaces that don't have a task packet.
- **Search v2 / command-first integrations** — `shrk recommend` now combines recipes + routing hints + universal search and emits an explicit "coverage gap" message when nothing matches. `shrk context --task` surfaces top commands + routing hints prominently before the long context body. `shrk task` adds a top "Commands first" panel. New flags: `--commands-first`, `--actions-only`, `--machine-json`.
- **Fix preview polish** — every suggestion now carries a stable `id`, `confidence`, `humanReviewRequired`, and `reason`. `writeFixPreviewDrafts()` writes drafts strictly under `.sharkcraft/fixes/` (refuses path escapes). Each suggestion can carry an optional `patchPreview`.
- **Feedback actions v2 improvementKind** — each `IFeedbackAction` now declares `improvementKind: 'engine' | 'pack' | 'local-config' | 'docs' | 'unknown'` so the human knows where the resulting fix should land.
- **Self-config doctor cross-refs** — verifies template `metadata.requiredConventionIds`, `requiredHelperIds`, `requiredProfileIds`, and `registrationHintIds` resolve. Verifies routing hint targets (templates / helpers / conventions / profiles).
- **Pack reliability fixes (pack-only)** — plugin-contract templates scaffold events.ts with stable anchor regions (`// region:events:enum`, `:body`, `:module-augmentation`). Event templates become a multi-op plan (ensure-import + insert-enum-entry + insert-between-anchors) — no more broken first-run code, no more manual enum-entry insertion. Policy templates move contracts under `contracts/I<Pascal>Policy.ts` (no orphan files). New plugin-policy-folder-layout convention. Four registration hints (composer / event-route / capability / sandbox-demo).
- **Docs**: `docs/registration-hints.md`, `docs/template-anchors.md`. `docs/folder-plan-ops.md` updated with apply pipeline integration.

### Changed

- `IPluginLifecyclePlan` → saved plan conversion drops no-op replaces.
- `IFixPreviewReport.suggestions[]` decorated with stable id + confidence + reason + humanReviewRequired by `annotateSuggestion`.
- `ISavedPlan` validation rejects malformed `folderOps[]` entries.

### Safety / MCP / project-coupling

- No new MCP write tools. R35 adds three MCP tools — all strictly read-only.
- No fake signing. Adopter pack manifest signatures reported **stale** honestly with the re-sign command (`SHARKCRAFT_PACK_SECRET` not set in this environment).
- `shrk safety audit --deep` passes.
- Project-coupling audit remains clean — zero project-specific tokens in `packages/**`.
- `bun run release:preflight` passes all required steps.

### Migration notes

- Templates that want to use anchor-driven insert ops (`insert-enum-entry`, `insert-between-anchors`) should declare `producedAnchors` (on the producer scaffold) and `requiredAnchors` (on the consumer) in `metadata`.
- Pack authors adopting registration hints: add `registrationHintFiles: ['./src/assets/registration-hints.ts']` to the manifest and re-sign.

## [Unreleased] — R33 closure: universal search, uncertainty, fix preview, folder ops, PR summary, feedback v2 (R34)

### Added

- **Adopter pack R33 slots adopted** — `conventionFiles`, `taskRoutingHintFiles`, `helperFiles` populated in an adopter pack with concrete plugin-folder-layout / feature-key / barrel conventions, plugin rename/remove routing hints, and pack-contributed helpers. Re-restored `pluginLifecycleProfileFiles` after the R33 regression.
- **Shared uncertainty report** — `IUncertaintyReport` (schema `sharkcraft.uncertainty-report/v1`) extends the R31 summary with `reasons[]`, `missingSignals[]`, `conflictingSignals[]`, `suggestedCommands[]`, `safeFallbackCommand`, and `whatWouldIncreaseConfidence[]`.
- **Universal search v2** — `shrk search "<query>"` becomes the discovery palette across every contribution kind (commands / MCP tools / knowledge / rules / paths / conventions / templates / helpers / playbooks / constructs / policies / decisions / scaffold patterns / contract templates / migration profiles / plugin lifecycle profiles / feedback rules / task routing hints / docs / reports). 7-section output (best actions / commands / contributions / knowledge / validation / uncertainty / why). `--commands-only`, `--actions-only`, `--kind`, `--source`, `--limit`, `--format`, `--legacy`. MCP `search_unified` read-only.
- **Fix preview expansion** — new kinds: `boundary`, `convention`, `self-config`, `pack-conflict`, `stale-pack-signature`, `missing-command-hint`, `missing-convention-reference`, `missing-template-reference`, `broken-playbook-reference`, `broken-agent-test-reference`, `broken-routing-hint-reference`, `broken-helper-reference`. `buildFixPreviewExtended` (async) merges them with the R31 built-ins. CLI flags wired one-per-kind plus `--all`. Default no-arg invocation also runs `self-config` / `pack-conflict` / `stale-pack-signature` now.
- **Folder op apply** — `applyFolderOps()` in `@shrkcrft/generator` executes `rename-folder` / `delete-folder` operations behind strict safety gates (`checkFolderOpSafety` + `--allow-folder-ops` + `--allow-delete-folder`). Default is dry-run; never fake-signs anything. Tests cover safe rename, unsafe rejection, delete-without-flag rejection, and explicit-flag deletion.
- **PR summary from session / bundle** — `shrk pr summary|description --from-session <id>` reads `appliedPlans[].changedFiles[]`; `--from-bundle <id>` reads `.sharkcraft/bundles/<id>/manifest.json`.
- **Feedback actions v2** — schema `sharkcraft.feedback-actions/v2` plus three richer output shapes (`backlog`, `prompt`, `plan`). `shrk feedback actions <file>` now emits v2 by default; `--legacy` keeps the v1 output. New `shrk feedback backlog|prompt|plan` subcommands.

### Changed

- `shrk search` defaults to the universal v2 output; pass `--legacy` for the R30-style flat list.
- `shrk feedback actions` defaults to v2; pass `--legacy` for the R30 shape.
- `IPluginLifecyclePlan.folderOps[]` is now exercised end-to-end (engine emits with safety verdict; `applyFolderOps` consumes with explicit allow flags).

### Safety

- No new MCP write tools. `search_unified` is the only R34 MCP tool added; it is read-only. `ALL_TOOLS` ↔ `ALL_TOOLS_FOR_AUDIT` parity tests still green.
- Folder ops default to preview-only. Apply rejects unsafe paths *before* touching the filesystem; tests prove rejection of `.git`, `node_modules`, outside-project, and delete-without-flag.
- Pack signatures still never fake-signed. `applyFolderOps` does not write unless the caller passes both `dryRun: false` and the explicit allow flag.

### Acceptance

- Engine package scan → clean outside fixtures.
- `shrk migrate project-coupling audit --fail-on engine` → verdict `clean`, blocking `0`.

## [Unreleased] — Generic extension platform hardening + product coherence + daily dev loop (R33)

### Added

- **Pack contributions / conflicts UI** — `shrk packs contributions [--pack <name>] [--kind <kind>]` and `shrk packs conflicts [--severity ...]` (schema `sharkcraft.pack-contributions-inventory/v1`). Enumerates 24 contribution kinds. MCP `get_pack_contributions`, `get_pack_conflicts`.
- **Conventions system** — `IConvention` + `conventionFiles[]` manifest slot + registry + CLI `shrk conventions list|get|doctor|check|explain` + MCP `list_conventions` / `get_convention` / `get_conventions_doctor`.
- **Pack-contributed helpers** — `IPackHelper` + `helperFiles[]` + registry + safety metadata + MCP `list_helpers` / `get_helper`.
- **Task routing hints** — `ITaskRoutingHint` + `taskRoutingHintFiles[]` + registry + CLI `shrk routing hints list|doctor` / `shrk routing explain "<task>"` + MCP `list_task_routing_hints` / `explain_task_routing`.
- **Self-config doctor (P0)** — `shrk self-config doctor|graph|broken-links|report` + MCP `get_self_config_doctor` / `get_self_config_graph`. Cross-reference walker across knowledge / search-tuning / agent-tests / pack contributions / stale signatures.
- **Generic profile registry** — unifies plugin-lifecycle + migration profiles under `shrk profiles list|get|doctor|search` + MCP `list_profiles` / `get_profile` / `get_profiles_doctor`.
- **Dev cycle** — `shrk dev cycle --plan|--run|--until-green` with 4 profiles (sharkcraft-self / pack-author / project-consumer / release). MCP `get_dev_cycle_plan` (read-only).
- **CI predict** — `shrk ci predict|would-fail` over cached `.sharkcraft/reports/*.json`. MCP `get_ci_prediction`.
- **Pack signature freshness** — `shrk packs signature-status` + MCP `get_pack_signature_status`. Detects stale signatures without needing the secret. Never fake-signs.
- **Canonical agent task entrypoint** — `prepare_agent_task` MCP tool bundles intent / confidence / commands / profiles / safety notes for first-call agent setup.
- **Folder plan ops (planning + safety)** — `FileChangeType.RenameFolder` / `DeleteFolder` + `checkFolderOpSafety` + `shrk plugin rename|remove --emit-folder-ops`. Apply layer landed in R34.
- **Template profile metadata** — `template.metadata.requiredProfileIds|requiredConventionIds|requiredHelperIds|requiredLanguages|requiredFrameworks` (alongside `forbiddenPathFragments`).
- **Project-coupling regression gate** — `--fail-on engine|any|never`, word-boundary detection (false-positive classification), expanded token set documented.

### Changed

- `shrk migrate project-coupling audit` defaults to word-boundary matching; substring-in-identifier matches are demoted to `false-positive`.
- `shrk packs` adds `contributions`, `conflicts`, `signature-status` subverbs.
- `shrk plugin lifecycle` adds `profiles`, `profile <id>`, `doctor` subverbs.

### Safety

- Every R33 MCP tool is read-only; `ALL_TOOLS_FOR_AUDIT` parity tests green.
- New CLI surfaces are read-only / preview-only; folder ops default to manual checklist.
- Adopter pack signatures handled honestly (stale reported, never fake-signed).

## [Unreleased] — Generic extension platform, profiles, project-coupling migration (R32)

### Added

- **`IPluginLifecycleProfile`** (`packages/plugin-api/src/plugin-lifecycle-profile.ts`) — pack-contributable typed description of plugin layouts (pluginRoots, barrels, keyTable, registryFiles, naming, validationCommands, safetyNotes, appliesWhen, tags). Includes runtime validator. Pack manifest gains `pluginLifecycleProfileFiles[]` slot.
- **Plugin lifecycle profile registry** — `packages/inspector/src/plugin-lifecycle-profile-registry.ts` loads local + pack-contributed profiles, dedupes by id, attributes source. `resolvePluginLifecycleProfile` resolves `--profile <id>` with single-default semantics.
- **Generic profile registry** — `packages/inspector/src/profile-registry.ts` unifies plugin-lifecycle + migration profiles under a single typed surface for the new `shrk profiles list|get|doctor|search` command. MCP: `list_profiles`, `get_profile`, `get_profiles_doctor`.
- **Profile-driven plugin lifecycle** — `packages/inspector/src/plugin-lifecycle.ts` rewritten to accept `IPluginLifecycleProfile`. Removed the legacy adopter-specific context type, loader, profile literal, and every hardcoded adopter path. Generic case-conversion handles upperSnake / pascal / camel / kebab. `checkPluginLifecycleProfileHealth` reports missing profile paths.
- **`shrk plugin lifecycle profiles|profile|doctor`** — new subcommands for inspecting registered profiles. `shrk plugin rename|remove|lifecycle list|inspect` now take `--profile <id>` (implicit when exactly one profile is registered; clear error listing available ids otherwise).
- **Pack-contributed contract templates** — `contractTemplateFiles[]` manifest slot + `loadAllContractTemplates` registry. Six project-specific built-in contracts removed from the engine (UI feature, runtime feature, plugin-API change, sandbox demo, devtools feature, removal refactor); engine ships six generic built-ins.
- **Pack-contributed migration profiles** — `migrationProfileFiles[]` manifest slot + `loadMigrationProfiles` registry. Engine ships zero built-in migration profiles; `buildMigrationReadiness({ customProfiles })` accepts pack/local profiles.
- **Project-coupling migration helper** — `shrk migrate project-coupling audit|plan|report --token <pat> [...]` (schema `sharkcraft.project-coupling-audit/v1`). Scans configurable deny tokens across packages/, sharkcraft/, apps/, libs/, examples/, docs/. Classifies each hit as `pack | local-config | profile | fixture-only | docs-example`. Read-only. MCP: `get_project_coupling_report`.
- **Adopter pack lifecycle profile** — adds a `tools/sharkcraft-pack/src/assets/plugin-lifecycle-profile.ts` (three roots / three barrels / one feature-key table) and declares it via `pluginLifecycleProfileFiles[]`. Signature reported as **honest-stale** (no `SHARKCRAFT_PACK_SECRET` in this environment).

### Changed

- **Helper registry** — IDs renamed to a `core.*` namespace. Bodies are now generic; helpers that need adopter-specific paths require an `IPluginLifecycleProfile` arg.
- **`packs new --kind`** — legacy adopter-named kind renamed to `platform-adopter`.
- **`release smoke --target`** — legacy adopter-named target renamed to `adopter`; `--adopter-root` flag plus `SHARKCRAFT_ADOPTER_ROOT` env var.
- **Demo scenarios** — legacy adopter-named demo plugin renamed to `PlatformPlugin`; demo body is pack-agnostic.
- **Migration readiness** — `IMigrationReadinessOptions` gains `customProfiles?: readonly IMigrationProfile[]`. CLI/MCP load pack-contributed profiles and pass them in.
- **`plan-simulation`** markers renamed to generic `KEY_TABLE_MARKERS` and now include profile-derived names plus generic conventions.
- **`ranker-explainability`** — Project-specific tokens removed from hardcoded domain inference; pack search-tuning takes over.
- **`constructs impact`** — `registryTouchPoints` derived from the active lifecycle profile instead of a hardcoded adopter path.
- **SharkCraft self-config** — knowledge / agent-tests / decisions / search-tuning cleaned of project-specific content. New `engine.plugin-lifecycle-profiles` and `engine.project-coupling-migration` entries.

### Safety

- All new MCP tools are **read-only**. Safety audit + audit-list parity test pass.
- `shrk plugin rename|remove` is still plan-only.
- `shrk migrate project-coupling …` is read-only; `report` writes only under `.sharkcraft/reports/`.
- Adopter pack manifests now include `pluginLifecycleProfileFiles[]` but **signatures are honestly stale** — no fake-signing.

### Acceptance

- Engine package scan returns zero hits outside test fixtures.
- `shrk migrate project-coupling audit` returns `clean` for engine packages.

## [Unreleased] — Developer loop, explainability, pack adoption, CI reporting (R31)

### Added

- **Ranker explainability** — `shrk why <id> --for-task "<task>"` and `shrk why-not <id> ...` (schema `sharkcraft.ranker-explainability/v1`) answer "why was X included/not for task Y?" without writing an agent test. Reports matched/missing signals, score, rank, threshold, outranked-by, search-tuning trace, suggested metadata fixes. `--kind` / `--for-query` / `--format text|markdown|html|json` flags. MCP: `get_ranker_explanation`, `get_ranker_why_not` (read-only).
- **Command discovery + did-you-mean** — `shrk commands suggest "<partial>"`, `shrk commands explain "<cmd>"`, and unknown-command did-you-mean hints. Typo-tolerant (`knowlege` → `knowledge`). `--safe-only` / `--mcp-safe-only` / `--category` filters. Group-level help via `shrk <group> --help` and `shrk help <group>`. MCP: `suggest_commands`, `search_commands`, `explain_command` (read-only).
- **Watch loops** — `shrk doctor watch [--once] [--debounce N]`, `--watch` flag on `shrk knowledge stale-check` / `shrk templates drift` / `shrk test agent`, and a combined `shrk watch integrity [--once]` that runs doctor + stale-check + drift + agent tests in one debounced loop. Linux fallback when recursive fs.watch is unsupported.
- **Fix preview system** — `shrk fix list|doctor|preview` (`--action-hints` / `--knowledge-stale` / `--template-drift`). Preview-only by default. `--write-preview` writes only under `.sharkcraft/fixes/`. Stubbed action-hint bodies are explicitly marked `needs-human-fill`; doctor continues to warn until filled. Schema: `sharkcraft.fix-preview/v1`. MCP: `preview_fix`, `list_fix_kinds` (read-only).
- **Scaffold coverage gap reporting** — `shrk coverage scaffolds --task "<task>"|--domain <domain>` (schema `sharkcraft.scaffold-coverage/v1`) reports per-axis coverage (knowledge / rules / paths / templates / scaffold-patterns / playbooks / helpers / validation-commands / contract-templates) + grade (full/partial/weak/missing) + suggested additions. Integrates into `shrk task --show-coverage-gaps`. MCP: `get_scaffold_coverage_report` (read-only).
- **Search-tuning explain CLI** — first-class top-level alias `shrk search-tuning <list|doctor|explain>` plus `--kind`, `--source`, `--limit`, `--format text|markdown|html|json` flags on the existing subcommand form.
- **Direct symbol impact / trace** — `shrk impact --symbol <Name>` and `shrk trace --symbol <Name>` use the AST-backed symbol index (`findSymbolInProject`) to walk the project, resolve exact-export / exact-local / probable-text matches, and run file-impact when exactly one exported declaration exists. `--language typescript|java|csharp|python|go|rust|auto` filter.
- **Changes summary** — `shrk changes summary [--since <ref>|--staged|--files a,b]` (schema `sharkcraft.changes-summary/v1`) groups the diff by package/area, flags MCP / safety-relevant / write-path / pack-asset files, classifies risk low/medium/high, and suggests validation commands. MCP: `get_changes_summary` (read-only).
- **PR summary generator** — `shrk pr summary [--since|--staged|--files] [--format markdown|json] [--output <file>]` (schema `sharkcraft.pr-summary/v1`) renders a deterministic PR description from the changes summary + reports under `.sharkcraft/reports/`. Sections: Summary, Why, What changed, Safety, Validation, Risk/review, Breaking, Migration, Known limitations, Follow-ups, Commands run, Reports. MCP: `get_pr_summary_preview` (read-only).
- **CI integrity report aggregator** — `shrk ci report [--reports-dir <dir>] [--format text|markdown|html|json] [--fail-on error|warning|none]` (schema `sharkcraft.ci-integrity/v1`) reads the JSON gates under `.sharkcraft/reports/` and renders a single overall verdict + per-gate breakdown + PR-comment-ready markdown. MCP: `get_ci_integrity_report` (read-only).
- **Failure-to-success hints** — `packages/cli/src/output/failure-hints.ts` centralizes next-command suggestions used by doctor / stale-check / template drift / ci report.
- **Uncertainty reporting** — `shrk task` always appends a confidence + uncertainty footer (`sharkcraft.uncertainty/v1`). Signals: no template / no path convention / no validation command / weak knowledge / low ranker confidence. `--show-coverage-gaps` includes the coverage report inline.
- **SharkCraft self-config polish (R31)** — 11 new knowledge entries (46 total, 112 references — all green via stale-check), 10 new search-tuning bias entries, 6 new agent-contract tests (18 pass).
- **Adopter pack adoption** — a representative adopter pack now ships 36 path conventions (R31 added 16 covering plugin defaults / events / commands / barrels / primitives / adapters / value wrappers / sandbox demos / drag-drop / devtools panels / registry lifecycle / runtime services / kernel) and 17 pack feedback rules (primitive adapter, sandbox demo, layout engine, drag-drop, registry lifecycle, plugin lifecycle, boundary baseline noise, canonical path mismatch, template drift, etc.). Pack manifest accepts `feedbackRuleFiles[]`, `decisionFiles[]`, `pathConventionFiles[]` slots.

### Changed

- `shrk impact` accepts `--symbol <Name>` (was: path / specifier / fuzzy id only).
- `shrk trace` accepts `--symbol <Name>` (was: free-form query only).
- `shrk coverage` adds a `scaffolds` subverb.
- `shrk doctor` / `knowledge stale-check` / `templates drift` accept `--watch [--once] [--debounce N]`.
- `shrk task` always emits a confidence + uncertainty footer; `--show-coverage-gaps` adds the coverage report inline.

### Safety

- All R31 MCP tools are read-only; safety audit confirms zero write-capable MCP tools.
- `shrk fix preview --write-preview` writes only under `.sharkcraft/fixes/`; never modifies source.
- Unknown commands print did-you-mean suggestions but never execute the suggested command — humans run the CLI.
- Adopter pack signatures are intentionally stale after R31 adoption (no fake signing). Re-sign locally with `SHARKCRAFT_PACK_SECRET=<secret> shrk packs sign ...`.

## [Unreleased] — CI gates, fuzzy impact, strong agent tests, knowledge integrity hardening (R30)

### Added

- **Fuzzy `shrk impact <query>`** — `packages/inspector/src/fuzzy-impact.ts` (schema `sharkcraft.fuzzy-impact-resolution/v1`). The impact command now resolves free-form queries (file path, construct id, plugin key, symbol, template/helper/playbook/knowledge/command id) via the same R29 resolver used by `shrk trace`. New flags: `--resolve` / `--resolve-only` / `--explain-resolution` / `--no-resolve`. Auto-runs impact only on exact / high confidence; surfaces alternatives otherwise. MCP: `get_fuzzy_impact_report` (read-only).
- **Stronger agent test expectations** — `IAgentContractTest` gains `expectedHelpers`, `expectedPlaybooks`, `expectedPolicies`, `expectedConstructs`, `expectedCommands`, `expectedKnowledge`, `minConfidence`, `mustNotInclude`. Async `loadAgentContractRegistries` pre-loads policy / playbook / construct id sets so the sync runner stays sync. SharkCraft self agent tests strengthened across rename / remove / renderer / editor / sandbox / helper / CLI / MCP / inspector / polyglot tasks.
- **Knowledge stale-check CI/preflight gate** — `shrk knowledge stale-check [--ci] [--strict] [--fail-on required|stale|missing|all] [--baseline <file>] [--report] [--format text|markdown|html|json] [--output <path>]`. Local mode stays non-blocking; `--ci` blocks on required-true reference failures; `--strict` blocks on any required failure; `--baseline` computes new-stale / new-missing / resolved diffs. Wires into `shrk release readiness --with-knowledge-check` and respects `sharkcraft.config.ts knowledgeCheck.{enabled,strict,failOn}`.
- **AST-backed symbol verification** — `packages/inspector/src/symbol-index.ts` (schema `sharkcraft.symbol-index/v1`) uses the TypeScript compiler (`createSourceFile`) to parse single files and resolve symbols as `exact-export | exact-local | exact-reexport | probable-text | missing | unknown`. No full-program type-checking, no new dependencies (typescript is already present). Falls back to the R29 text scan when parsing fails. `shrk knowledge stale-check` now uses it for `kind: symbol` references.
- **Template drift severity controls** — `shrk templates drift` gains `--min-severity error|warning|info`, `--hide <code>[,<code>...]`, `--strict`, `--ci`, `--format text|markdown|html|json`, `--report`, `--output`. Strict mode promotes warnings to errors for exit-code purposes only.
- **Pack-contributed feedback rules** — `IFeedbackRule` (schema `sharkcraft.feedback-rule/v1`). Loaded from `sharkcraft/feedback-rules.ts` + pack `feedbackRuleFiles[]`. New CLI: `shrk feedback rules list|doctor`, `shrk feedback ingest <file> --with-pack-rules`, `shrk feedback actions <file> --with-pack-rules`. SharkCraft local rule pack (8 rules) covers fuzzy-impact / knowledge-ci / template-drift / agent-test-ranker / changed-only / mcp-readonly / warning-noise / feedback-rules. MCP: `list_feedback_rules`, `get_feedback_rule` (read-only).
- **TypeScript decisions loader** — `loadTsDecisions` reads `sharkcraft/decisions.ts` + pack `decisionFiles[]`. Markdown ADRs remain primary; TS entries fold in via cache. Duplicate ids skip with markdown winning. New: `shrk decisions doctor` validates id uniqueness + presence of Context/Decision/Consequences. SharkCraft self ships 10 TS decisions in addition to the 12 markdown ADRs. MCP: `get_decisions_report` (read-only).
- **CI scaffold integrity gates** — `shrk ci scaffold <provider> --with-knowledge-check --with-template-drift --with-integrity` adds the R29/R30 integrity gates to generated CI workflows. Each gate writes JSON under `.sharkcraft/reports/` for artifact upload symmetry.
- **SharkCraft self-config polish** — 8 new R30 knowledge entries (35 total, 77 references — all green via stale-check). 9 new search-tuning bias entries covering R30 surface. 8 R30 feedback rules. 10 R30 TS decisions. 4 new strict agent-test expectations across the 12 existing tests.
- **MCP — 4 new read-only tools** — `get_fuzzy_impact_report`, `list_feedback_rules`, `get_feedback_rule`, `get_decisions_report`. All read-only; no write capability added.

### Changed

- `shrk impact <input>` extends positional handling to accept fuzzy queries via the resolver, in addition to file paths and import specifiers. Default behaviour for existing file/specifier callers is unchanged.
- `shrk decisions list` warms the TS cache so TS decisions fold in alongside markdown ADRs.

### Safety

- All R30 MCP tools are read-only; safety audit confirms 0 write-capable MCP tools.
- `shrk knowledge stale-check` default mode is non-blocking; CI gating is opt-in via flags or `knowledgeCheck.{enabled}` config.
- `shrk templates drift --strict` promotes warnings → errors for exit code only; nothing is written.
- CI scaffold gates are explicit opt-in flags; no behaviour change for existing `--with-*` flags.
- Adopter source is **not** modified by R30. Recommended adopter pack additions (path conventions, feedback rules) are documented as advisory reports under the adopter's `.sharkcraft/reports/` directory.

### Tests

- +21 R30 tests covering fuzzy impact resolution (7), AST symbol index (7), feedback ingestion with pack rules (3), strict agent contract expectations (5). Total suite: **1081/1081 pass**.

## [Unreleased] — Changed-only quality v2 + knowledge integrity + template drift + SharkCraft self-improvement (R29)

### Added

- **Changed-only quality model v2** — `packages/inspector/src/changed-scope.ts` with `IChangedScopeClassification` (schema `sharkcraft.changed-scope/v1`) and buckets `new-in-changed-file | existing-touched | existing-untouched-hidden | resolved | unknown | unchanged | out-of-scope`. Wired into `shrk policy run` and `shrk drift` via `--changed-only|--since|--staged|--files`.
- **Doctor warning noise control** — `shrk doctor --focus errors,warnings-new,info | --hide action-hint-quality,... | --quiet-known`. `shrk doctor suppress` and `shrk doctor suppressions list|check`. Persistence: `sharkcraft/doctor.suppressions.json` (schema `sharkcraft.doctor-suppressions/v1`). Errors are NOT suppressed unless `allowError: true`. Expired suppressions surface as a warning.
- **Knowledge references + anchors** — `IKnowledgeEntry.references[]` (`file | directory | symbol | command | template | playbook | construct | helper | policy | boundary-rule | path-convention | package | url`) and `IKnowledgeEntry.anchors[]` (`file | symbol | command | construct | template | helper | playbook | policy`). Backwards-compatible — pre-R29 entries still load.
- **Knowledge stale-check** — `shrk knowledge stale-check [--changed-only|--since|--staged|--files]`, `shrk knowledge verify`, `shrk knowledge references <id>`, `shrk knowledge anchors`. Schema: `sharkcraft.knowledge-stale/v1`. No network, no AI. Symbol checks use deterministic text scan with confidence `exact | probable | missing | unknown`.
- **Knowledge rename / anchor drift advisory** — `shrk knowledge rename-symbol <old> <new>`, `shrk knowledge rename-file <old-path> <new-path>`, `shrk knowledge update-anchor <anchorId> [--to-symbol|--to-path|--to-target-id <value>]`. Dry-run by default; `--write` saves patches under `sharkcraft/knowledge-updates/`.
- **Template drift verification** — `shrk templates drift [--template <id>] [--pack <packId>]`, `shrk templates verify-paths`, `shrk templates smoke`. Schema: `sharkcraft.template-drift/v1`. Checks forbidden legacy fragments (e.g. `contracts/<name>` for plugin-contract templates), missing barrels for `export` ops, missing anchors, unresolved related ids.
- **Anchor-aware barrel insert** — `buildBarrelExportOperation({ targetPath, from, symbol?, sort: 'alphabetic'|'append', group?, idempotencyMarker? })`. Detects duplicate exports, alphabetic insertion target, ambiguous-style conflicts (`export *` mixed with `export { ... }` for the same source).
- **Fuzzy trace** — `shrk trace <query> [--deep] [--limit <n>] [--kind file|construct|knowledge|template|helper|playbook|policy|command]`. Resolves any free-form query against multiple registries with confidence `exact | high | medium | low | unknown` and surfaces alternatives.
- **Feedback ingestion** — `shrk feedback <ingest|summarize|actions|convert-to-backlog> <file>`. Deterministic keyword/rule-based extractor — no AI. Schema: `sharkcraft.feedback-ingestion/v1`. Detects changed-only asks, stale knowledge, template drift, warning noise, fuzzy-trace asks, plugin lifecycle, registry lifecycle, polyglot terms.
- **SharkCraft self policies** — `sharkcraft/policies.ts` with 11 policies: `mcp-read-only`, `apply-requires-explicit-verify-for-signed-plans`, `no-destructive-without-approval`, `ingest-adopt-allowlist`, `plan-v2-no-hidden-side-effects`, `contract-gate-opt-in-but-strict-when-used`, `helper-preview-only-mcp`, `language-runner-allowlist`, `memory-local-only`, `template-drift-must-be-detectable`, `mcp-read-only-comment`. All pass.
- **SharkCraft self decisions/ADRs** — `sharkcraft/decisions/` with 12 ADRs: `mcp-read-only-forever`, `plan-v2-no-delete-op`, `ingest-adopt-stub-bodies`, `changed-only-per-file`, `contract-gates-are-opt-in`, `memory-is-local-only`, `helpers-produce-plans-not-writes`, `polyglot-support-is-advisory-until-enforced`, `template-drift-checks-before-trust`, `knowledge-is-verifiable-not-tribal`, `no-auto-publish-no-auto-tag`, `pack-assets-are-contracts`.
- **SharkCraft self agent tests** — `sharkcraft/agent-tests.ts` with 12 tests: rename / remove a plugin, add renderer / editor / sandbox / helper plan / CLI command / MCP tool / inspector module, fix changed-only boundary, add polyglot Java support, debug ModuleNotFoundError. 12/12 pass.
- **SharkCraft self scaffold patterns** — `sharkcraft/scaffold-patterns.ts` with 8 patterns: `sharkcraft.cli-command`, `sharkcraft.mcp-tool`, `sharkcraft.inspector-module`, `sharkcraft.command-catalog-entry`, `sharkcraft.json-schema`, `sharkcraft.docs-page`, `sharkcraft.policy`, `sharkcraft.decision`. Loader extended to read local `sharkcraft/scaffold-patterns.ts` (was pack-only).
- **SharkCraft self knowledge entries** — `sharkcraft/knowledge.ts` with 16 R29 entries describing the engine surface, each with structured `references[]`. 48 references, all verified by `shrk knowledge stale-check`.
- **SharkCraft self search tuning** — `sharkcraft/search-tuning.ts` with 16 bias entries spanning the R28 adopter surface, SharkCraft engine, and polyglot terms.
- **MCP — 8 new read-only tools** — `get_doctor_suppressions`, `get_doctor_filtered_report`, `get_knowledge_stale_report`, `get_knowledge_references`, `preview_knowledge_rename`, `get_template_drift_report`, `resolve_query`, `trace_query`, `preview_feedback_actions`. All read-only; no write capability added.

### Changed

- `shrk policy run` and `shrk drift` accept `--changed-only|--since <ref>|--staged|--files a,b,c`. The default behaviour is unchanged.
- Top-level CLI dispatch falls through to a top-level handler when the second arg starts with `-` (lets `shrk doctor --hide ...` work alongside `shrk doctor <subcommand>`).

### Safety

- All R29 helpers default to dry-run / plan generation. The MCP read-only invariant is enforced by the new `sharkcraft.mcp-read-only` local policy.
- `shrk doctor suppress` writes only under `sharkcraft/doctor.suppressions.json` (a config file, not source).
- `shrk knowledge rename-*` writes only under `sharkcraft/knowledge-updates/` when `--write` is passed.

### Tests

- +20 R29 tests covering changed-scope classification, doctor suppression, knowledge stale-check, template drift, barrel operations, fuzzy resolver, feedback ingestion. Total suite: 1060/1060 pass.

## [Unreleased] — Adopter feature accelerator + lifecycle helpers + boundary changed-only (R28)

### Added

- **Boundary changed-only mode** — `shrk check boundaries --changed-only|--since <ref>|--staged|--files a,b,c [--json]`, `shrk boundaries enforce --changed-only`, `shrk architecture violations --changed-only`. Filters violations to changed files; emits `mode`, `changedFiles`, `includedViolations`, `ignoredLegacyCount`, `ignoredLegacyByRule`. Works for both the TS engine and the polyglot engine. The default behaviour is unchanged. Module: `packages/inspector/src/boundaries-changed-only.ts`. MCP: `get_changed_boundary_report` (read-only).
- **Adopter canonical path fix** — plugin-contract and plugin-cross templates now emit `plugin-api/.../plugins/<name>/{config,state,events,api,index}.ts` and `plugin-cross/.../plugins/<name>/plugin.ts` (was `contracts/<name>/i-<name>-*.ts` and `<Pascal>Plugin.ts`).
- **9 adopter runtime/UI templates** covering angular renderer, angular editor, sandbox demo, plugin UI component, plugin runtime service, plugin event route, plugin command action, plugin drag-drop, devtools panel. Each scaffolds a minimal useful surface + a barrel export via a plan-v2 `export` op. No business logic embedded.
- **10 adopter feature playbooks** covering add-renderer-feature, add-editor-feature, add-sandbox-demo, add-plugin-ui-flow, add-runtime-integration, add-event-route, add-command-action, add-drag-drop-flow, add-devtools-panel, extend-existing-plugin. Each includes plan / human review / validate (`shrk check boundaries --changed-only`).
- **Plugin lifecycle helpers** — `shrk plugin rename <old> <new> --profile <id>`, `shrk plugin remove <name> --profile <id>`, `shrk plugin lifecycle list|inspect`. Plan-only via `sharkcraft.plugin-lifecycle/v1`: replace ops for feature-key tables + barrels, manual folder rename/delete checklist. Destructive plans require human approval. Module: `packages/inspector/src/plugin-lifecycle.ts`. MCP: `preview_plugin_rename`, `preview_plugin_remove` (read-only).
- **Helper plan generators** — `shrk helper list | get <id> | plan <id> --var k=v [--output <plan.json>]`. 13 helpers including add/remove/rename feature key, add/remove barrel export, add/remove event entry. Schema: `sharkcraft.helper-plan/v1`. Dry-run default. MCP: `list_helpers`, `get_helper`, `preview_helper_plan` (read-only).
- **Pack-author UX** — `shrk packs dev-status <packPath> [--consumer <repo>]` (detects source/symlink/node_modules + signed-manifest staleness + contribution counts). `shrk packs watch <packPath> [--command <cmd>] [--debounce <ms>] [--dry-run]` (never auto-signs). MCP: `get_pack_dev_status` (read-only).
- **Pack test runner** — `shrk packs test <packPath> --cases [--case <id>] [--update-snapshots]`. Loads `sharkcraft/pack-tests.ts` and runs `definePackTest({ id, task, expect*Ids, mustNotIncludeIds, maxTokens })`. Schema: `sharkcraft.pack-test-report/v1`. MCP: `preview_pack_tests` (read-only).
- **Registry lifecycle symmetry rule** — `shrk check registry-lifecycle`, `shrk registry lifecycle [--json]`. Scans for `register*` without matching `remove*` / `unregister*` / `clear*`. Honours `@shrkcrft lifecycle-ignore` and `@shrkcrft lifecycle-managed-by` annotations. Schema: `sharkcraft.registry-lifecycle/v1`. MCP: `get_registry_lifecycle_report` (read-only).
- **Construct trace/impact parity** — `shrk constructs trace <id> --deep`, `shrk constructs impact <id> [--json]` (`sharkcraft.construct-impact/v1`), `shrk constructs api <id> --public-only`, `shrk constructs related <id>`, `shrk constructs files <id>`. Impact enumerates registry touch points, verification commands, risk level, and human-review requirement.
- **Ingest adopt body assembly** — `shrk ingest adopt plan --include-body` (R27 follow-up). Extracts the entry body from the originating `sharkcraft/ingestion/generated/<X>.draft.ts` file when safe; falls back to the comment stub otherwise. Per-entry status: `materialised | stubbed | skipped | conflict`. Module: `packages/inspector/src/ingest-body-extractor.ts`.
- **Impact polyglot modes** — `shrk impact <file> --no-polyglot | --polyglot-only | --polyglot-mode auto|off|only`.
- **Language runner allowlist** — `sharkcraft/runner.allowlist.json` (`{ allow: [...], deny: [...] }`). `shrk languages runner config`, `shrk languages run --explain-policy`. Deny wins over allow; built-in dangerous deny patterns cannot be bypassed. MCP: `get_language_runner_policy` (read-only).
- **Adopter feature contracts** — 6 new templates covering UI feature, runtime feature, plugin-API change, sandbox demo, devtools feature, removal refactor.
- **MCP — 10 new read-only tools** — `get_changed_boundary_report`, `preview_plugin_rename`, `preview_plugin_remove`, `list_helpers`, `get_helper`, `preview_helper_plan`, `get_pack_dev_status`, `preview_pack_tests`, `get_registry_lifecycle_report`, `get_language_runner_policy`.

### Safety

- All R28 lifecycle helpers default to dry-run / plan generation. The `shrk apply --verify-signature` flow remains the only source-write path.
- No new MCP write tools. The deep safety audit remains green.
- `shrk packs watch` runs shell commands but never auto-signs the pack.
- `shrk plugin rename|remove` plans require human approval. The plan engine has no `delete-folder`/`rename-folder` op; folder operations are emitted as a manual checklist, never auto-executed.
- `shrk languages run` allowlist cannot bypass built-in dangerous deny patterns.

## [Unreleased] — polyglot enforcement + task understanding v2 + signed ingest apply (R27)

### Added

- **Language-aware repository knowledge model** — `IRepositoryKnowledgeModel` (`sharkcraft.repository-knowledge-model/v1`) now carries `languageProfiles`, `languageCommands`, `polyglotDependencySummary`, `polyglotTestImpactSummary`, `languageBoundarySuggestions`, `polyglotBoundaryReport`, `languageRiskNotes`, `languageGeneratedCodeSignals`, `languageStabilitySignals`. `IngestDepth.Deep` and `IngestDepth.Extreme` now drive deeper scans (deeper marker scan + dep summary + boundary report + annotation-based stability classification). Module: `packages/inspector/src/repository-knowledge-model.ts`.
- **Polyglot boundary enforcement** — `IPolyglotBoundaryReport` (`sharkcraft.polyglot-boundary-report/v1`) evaluates conservative built-in rules per language against the polyglot dep scan. New CLI: `shrk boundaries enforce --language all|java|csharp|python|go|rust`, `shrk languages boundaries`, `shrk check boundaries --polyglot`. Built-in rules: Java domain/no-spring-web, controller/no-repository-direct, main/no-test-import; C# domain/no-aspnet, web/no-infrastructure-direct, main/no-test-import; Python domain/no-web-framework, app/no-tests-import, no-cross-layer-parent-relative; Go pkg/no-cmd-import, internal/visibility, no-import-cycle-hint; Rust lib/no-tests-import, no-test-only-module-import, no-super-cross-crate-hint. MCP: `get_polyglot_boundary_report` (read-only). The existing TypeScript boundary engine is unchanged.
- **Language-aware memory index** — `IRepositoryMemoryIndex` (`sharkcraft.memory/v1`) gains `languageByFile`, `riskyFilesByLanguage`, `diagnosticsByLanguage`, `boundaryViolationsByLanguage`, `validationFailuresByLanguage`, `planConflictsByLanguage`, `languageHotspots`, `languageRiskTrend`. Memory still never lowers base risk; the hotspot list raises it.
- **Task understanding v2** — `shrk understand-task "<task>" [--explain]` and `shrk context build [--explain]` now use construct vocabulary, language vocabulary, symbol matching, stability-aware boosts, dependency-graph proximity, memory hotspot signal, generated-code exclusion, path-convention boost, pack-contributed construct/facet boost. Output includes `likelyFiles` with reasons, `likelyConstructs`, `likelyLanguages`, `likelyTests`, `riskyGeneratedFiles`, `stabilityWarnings`, `memoryWarnings`, `suggestedFirstCommands`, `confidence` (0–100).
- **Stability map v2** — `buildStabilityMap` accepts `scanAnnotations: true`; recognises `@deprecated`/`@experimental`/`@internal` JSDoc, Java `@Deprecated`, C# `[Obsolete]`/`[EditorBrowsable(Never)]`, Python `warnings.warn(..., DeprecationWarning)` / `# DEPRECATED`, Rust `#[deprecated]` / `#[doc(hidden)]` / `#[unstable]`, Go `// Deprecated:`. Driven by depth — turned on automatically at `IngestDepth.Deep`/`Extreme`.
- **Generated-code report v2** — `IBuildGeneratedCodeReportOptions.depth: GeneratedScanDepth` (standard / deep / extreme). New `GeneratedKind`s: `JavaGenerated`, `CSharpGenerated`, `PythonGenerated`, `GoGenerated`, `RustGenerated`. Per-language markers (Java `@Generated`/`javax.annotation.Generated`, C# `[GeneratedCode]`/`<auto-generated/>`, Python `# @generated`, Go `Code generated .* DO NOT EDIT`, Rust `bindgen`). Generated source roots: `target/generated-sources`, `target/generated-test-sources`, `build/generated`, `obj/`, `.openapi-generator/`, `prisma/generated`.
- **Ingest adoption apply plan** — `shrk ingest adopt plan | review | apply` reuses the existing `sharkcraft.plan/v1` schema + HMAC signing. Plans only target `sharkcraft/**` and `sharkcraft/docs/tasks/**`; the apply step refuses any other target. Default is dry-run; `--verify-signature` requires `SHARKCRAFT_PLAN_SECRET`. MCP: `preview_ingest_adoption_plan` (read-only, never persists).
- **Polyglot CI for all providers** — `shrk ci scaffold <provider> --polyglot` now emits per-language jobs/stages/steps for GitHub Actions / GitLab / Bitbucket / Azure DevOps / Jenkins. No publish / deploy / push commands.
- **Safe language command runner** — `shrk languages run [--category test|build|lint|format|check|typecheck|all] [--language <id>] [--command-id <lang.cat>] [--all-tests] [--execute] [--allow-install] [--report]`. Dry-run by default; execution is CLI-only. Refuses commands that match `publish/deploy/release/push/sudo/rm -rf /` patterns. MCP: `get_language_run_plan` (plan only — never executes).
- **Language profile cache** — `.sharkcraft/languages/cache.json` (`sharkcraft.language-cache/v1`). Opt-in via `--cache`; `--refresh-cache` rewrites the cache after detection. New: `shrk languages cache status | clear [--write]`. Stale-cache detection compares manifest mtimes/sizes + per-extension file counts/latest mtimes against the live tree. MCP: `get_language_cache_status` (read-only).
- **Polyglot impact integration** — `shrk impact <file>` appends a polyglot block for non-TS files: per-language files / likely tests / verification commands / boundary concerns / external deps.
- **Reports / dashboard / map** — `shrk report language` accepts `--include-boundaries` and `--include-memory`. `shrk dashboard-export` writes `languages.json`. `shrk report site` writes a `languages.html` page. `buildRepositoryMap` carries `languageCounts`.
- **MCP — 5 new read-only tools** — `get_polyglot_boundary_report`, `preview_ingest_adoption_plan`, `get_language_run_plan`, `get_language_cache_status`, `get_language_profiles_live`. All return data + a next-command hint; none write.

### Safety

- The MCP read-only invariant remains intact (audit gate unchanged). No new MCP write tools.
- `shrk languages run` is dry-run by default; execution requires `--execute`; install/restore are gated behind `--allow-install`; publish/deploy/push commands are refused even with `--execute`.
- `shrk ingest adopt apply` only writes under `sharkcraft/**` and `sharkcraft/docs/tasks/**`; every other target is refused. With `--verify-signature` the apply step requires an HMAC signature matching `SHARKCRAFT_PLAN_SECRET`.
- Language cache writes only to `.sharkcraft/languages/cache.json`. `shrk languages cache clear` is dry-run by default.
- No new auto-execution paths. No new publish/tag flows.

## [Unreleased] — repository knowledge model + ingest + Modern Angular preset (R26)

### Added

- **Repository knowledge model** — `IRepositoryKnowledgeModel`, schema `sharkcraft.repository-knowledge-model/v1`. Composes onboarding inference + architecture map + area map + construct registry + contradictions + generated-code report + stability map into a single deterministic model. Module: `packages/inspector/src/repository-knowledge-model.ts`. Sections: `repositoryOverview`, `architectureModel`, `businessLogicModel`, `rulesAndConventions`, `dependencyBoundaries`, `domainMap`, `workflowMap`, `changeProtocol`, `riskAreas`, `contradictions`, `openQuestions`, `generatedVsHandwritten`, `stableExperimentalDeprecated`, `taskContextHints`, `recommendedSharkCraftFiles`. Confidence + limitations + transformational-intent metadata.
- **`shrk ingest` command group** — `shrk ingest repository | refresh | status | report | adopt | diff | clean`. Dry-run by default. `--write-drafts` writes 26 draft files under `sharkcraft/ingestion/` (per-section markdown + 10 `*.draft.ts` files for knowledge/rules/paths/boundaries/constructs/policies/playbooks/templates/pipelines/presets). `--adopt` writes a patch + plan + summary under `sharkcraft/ingestion/adoption/` (never overwrites live `sharkcraft/*.ts`). Flags: `--preset` (repeatable), `--profile`, `--include`/`--exclude` (sections), `--depth shallow|standard|deep|extreme`, `--docs-first`, `--task`, `--format`, `--output`, `--json`.
- **Contradictions engine** — `IContradictionReport`, schema `sharkcraft.contradictions/v1`. Detects missing path references, deprecated CLI usage (`sharkcraft <verb>` → `shrk <verb>`), and missing script references in shell-fenced doc commands. CLI: `shrk contradictions [--format text|markdown|html|json]`.
- **Generated-code classifier** — `IGeneratedCodeReport`, schema `sharkcraft.generated-code/v1`. Detects `@generated`/`DO NOT EDIT`/OpenAPI/GraphQL/protobuf/Prisma banners, lockfiles, Angular env files, and generated roots. Recommends protect rules + policy gates. CLI: `shrk generated report|protect --write-drafts`.
- **Stability map** — `IStabilityMap`, schema `sharkcraft.stability-map/v1`. Classifies areas as `stable`/`experimental`/`deprecated`/`legacy`/`generated`/`internal`/`public-api`/`high-risk`. Signals: folder names, index-barrel presence, generated-root membership, fan-in (when import graph is available). CLI: `shrk stability map|area <id>`.
- **Task-specific context commands** — `shrk understand-task "<task>"`, `shrk validate-change [--files] [--since] [--staged]`, `shrk context build/refresh/status`. `understand-task` wraps task-packet + change-intent + risk + brief + knowledge model to return intent + relevant rules + likely files + risks + required validations + next safe command. `validate-change` surfaces boundary-suspect edits, generated-file edits, missing tests, and doc contradictions touched by the change. `context build` saves a per-task bundle under `.sharkcraft/context/task-contexts/<slug>.json` + `.md`.
- **R26 presets** — 28 new built-in presets: `generic-safe-repo`, `ai-agent-safe-development`, `enterprise-review-gated`, `strict-typescript`, `node-service`, `npm-package`, `modern-angular`, `angular-signals-first`, `angular-rxjs-disciplined`, `angular-standalone-components`, `angular-enterprise-architecture`, `angular-performance`, `angular-testing`, `angular-accessibility`, `angular-security`, `angular-plugin-platform`, `angular-enterprise-app`, `angular-library`, `angular-smart-ui-platform`, `vitest-focused`, `jest-focused`, `playwright-focused`, `react-app`, `vue-app`, `web-component-library`, `nestjs-service`, `express-service`, `fastify-service`. Modern Angular preset ships 16 representative rules (signals/RxJS/forms/routing/security/a11y/plugins). Strict-TypeScript preset ships 11 rules (any/satisfies/discriminated unions/promises/imports/branding).
- **MCP — 11 new read-only tools** — `create_repository_ingestion_plan`, `get_repository_knowledge_model`, `get_repository_ingestion_status`, `get_repository_ingestion_report`, `get_contradiction_report`, `get_generated_code_report`, `get_stability_map`, `get_ingest_adoption_preview`, `understand_task`, `get_task_context`, `validate_change_context`. All return data + a next-command hint; none write.
- **Fixtures** — `examples/ingest-angular-modern`, `examples/ingest-typescript-library`, `examples/ingest-layered-service`, `examples/ingest-docs-contradiction`, `examples/ingest-generated-code`.

### Safety

- `shrk ingest repository` is dry-run by default; `--write-drafts` only writes under `sharkcraft/ingestion/`; `--adopt` only writes under `sharkcraft/ingestion/adoption/`. Live `sharkcraft/*.ts` files are never overwritten.
- All R26 MCP tools are read-only. The MCP audit invariant is preserved.
- Pack signing, plan signing, apply gates, and contract approval flow are unchanged.
- The `shrk context --task "..."` flat usage continues to work; `build`/`refresh`/`status` are dispatched only when the first positional matches.

## [Previously released] — polyglot platform + contract precision + memory drift (R25)

### Added

- **Polyglot language detection** — new `shrk languages detect` (also `shrk report language`). Detects TypeScript / JavaScript / Java / C# / Python / Go / Rust by scanning canonical build/manifest files and counting source files. Reports per-language `confidence`, `sourceRoots`, `testRoots`, `buildFiles`, `testFrameworks`, `frameworkSignals`, `likelyCommands`. Module: `packages/inspector/src/languages/`. Schema: `sharkcraft.language-profile/v1`. MCP: `get_language_profiles`, `get_language_report` (read-only).
- **Polyglot command inference** — `shrk languages commands` produces per-language `install` / `restore` / `typecheck` / `test` / `lint` / `format` / `build` / `package` / `run` commands. Covers Maven, Gradle, dotnet, pip / poetry / uv (pytest / ruff / mypy), go, cargo. Schema: `sharkcraft.language-command-set/v1`. MCP: `get_language_commands` (read-only).
- **Polyglot dependency scanner** — `shrk languages deps [--language all|java|csharp|python|go|rust]` parses imports for the supported languages using deterministic regex rules. Distinguishes internal vs external dependencies via package/namespace/module declarations. Schema: `sharkcraft.polyglot-dependency-graph/v1`. MCP: `get_polyglot_dependency_graph` (read-only).
- **Polyglot test impact** — `shrk languages tests --files a,b,c` predicts per-language test files using deterministic naming conventions (`*Test.java`, `FooTests.cs`, `test_foo.py`, `foo_test.go`, `tests/foo.rs`). Schema: `sharkcraft.polyglot-test-impact/v1`. MCP: `get_polyglot_test_impact` (read-only).
- **Polyglot CI scaffold** — `shrk ci scaffold github-actions --polyglot` appends per-language jobs (Maven / Gradle / dotnet / Python / Go / Rust) when corresponding profiles are detected. Setup actions (`actions/setup-java`, `actions/setup-dotnet`, `actions/setup-python`, `actions/setup-go`, `dtolnay/rust-toolchain`). No publish / deploy steps. Other CI providers emit a guidance comment.
- **Polyglot boundary suggestions** — `shrk boundaries infer --language all|java|csharp|python|go|rust` adds per-language suggestion rules. Suggestions only — the existing boundary engine remains TS-aware.
- **Polyglot presets** — 7 new built-in presets: `java-maven-service`, `java-gradle-service`, `csharp-dotnet-service`, `python-service`, `go-module`, `rust-crate`, `polyglot-monorepo`.
- **Polyglot healing diagnostics** — 10 new diagnostic codes: `java-cannot-find-symbol`, `java-package-does-not-exist`, `csharp-cs0246`, `csharp-nu1101`, `python-module-not-found`, `python-pytest-collection-error`, `go-cannot-find-module`, `go-import-cycle`, `rust-e0432`, `rust-e0308`. `shrk heal from-error "<stderr>"` recognises each one.
- **Contract precision — glob-aware forbidden files** — new `IContractFileRule` (`kind: 'glob' | 'path-prefix' | 'exact' | 'contains'`) drives forbidden-files matching with deterministic glob support (`*`, `**`, `?`). `IAgentContract` now carries optional `allowedFilesDetailed?[]` / `forbiddenFilesDetailed?[]`. Legacy `forbiddenFiles: string[]` continues to work (treated as `kind: 'contains'`).
- **Contract approval expiry** — `shrk contract approve` accepts `--expires-in <duration>` (`30m` / `2h` / `7d` / `1w`) and `--expires-at <ISO>`. `shrk contract check` and `shrk contract status` now surface `approvalExpiry` with `valid` / `expires-soon` / `expired` / `no-expiry` / `absent`. High/critical-risk approvals without an expiry receive a warning.
- **Apply gate exit-code policy** — `shrk apply <plan> --contract <c> --json` now emits a structured `gateResult` block carrying `exitCategory` (`ok` / `blocked-contract-gate` / `blocked-signature` / `blocked-conflict` / `blocked-divergence` / `blocked-policy` / `blocked-boundary` / `blocked-validation` / `invalid-input`), `contractGateFailures[]`, `signatureStatus`, `suggestedNextCommand`. Exit code unchanged. Schema: `sharkcraft.apply-gate/v1`.
- **Memory drift / diff** — `shrk memory build --write-snapshot` archives the index under `.sharkcraft/memory/history/`. New `shrk memory diff <old.json> [new.json]` and `shrk memory drift [--previous <snapshot.json>]` compare two indexes and report `riskTrend` + new/resolved risky files + suggested actions. `shrk memory snapshots` lists the archive. Schema: `sharkcraft.memory-diff/v1`. MCP: `get_memory_diff`, `get_memory_drift` (read-only).
- **Contract templates** — 6 reusable templates: `ai-agent-safe-change`, `public-api-change`, `release-task`, `migration-task`, `security-sensitive-change`, `polyglot-service-change`. CLI: `shrk contract template list|get|render|recommend`. Schema: `sharkcraft.agent-contract-template/v1`. MCP: `list_contract_templates`, `get_contract_template` (read-only).
- **Execution graph DOT clustering** — `shrk agent graph "<task>" --graph-format dot --cluster` emits Graphviz subgraph clusters keyed by node kind. Stable colors + shapes. Plain `--graph-format dot` (no `--cluster`) is unchanged.
- **Report — language summary** — `shrk report language` emits a combined language report (profiles + commands + dependencies) in text / markdown / html / json.
- **Fixtures** — `examples/polyglot-{java-maven,java-gradle,csharp-dotnet,python-pytest,go-module,rust-cargo,mixed-service}`. Each is minimal: one source file, one test file, one build/manifest file. No installs, no build outputs.

### Safety

- MCP write-tool count unchanged: zero. All R25 MCP tools are read-only.
- Polyglot dependency scanner uses regex only; no compiler / AST integration. No new heavy runtime dependencies.
- `shrk memory build --write-snapshot` writes only under `.sharkcraft/memory/history/`.
- `shrk apply --contract` is still opt-in; the unflagged apply path is unchanged.
- Contract precision is fully backwards-compatible — old `forbiddenFiles: string[]` contracts still work.

### Catalog

- 9 new MCP tools registered in both `ALL_TOOLS` and `ALL_TOOLS_FOR_AUDIT`.
- New CLI surface: `shrk languages <detect|commands|deps|tests>`, `shrk memory <diff|drift|snapshots>`, `shrk memory build --write-snapshot`, `shrk contract template <list|get|render|recommend>`, `shrk contract approve --expires-in / --expires-at`, `shrk agent graph --cluster`, `shrk boundaries infer --language`, `shrk ci scaffold --polyglot`, `shrk report language`.

## [Unreleased] — memory-weighted risk + contract gates + handoff unification + plan-simulation diff + execution-graph DOT/query (R24)

### Added

- **Memory-weighted task risk** — `shrk risk "<task>" --include-memory` now actually adjusts the score. The report carries `baseScore` / `baseRiskLevel` / `adjustedScore` / `adjustedRiskLevel` and a `memory` block (`rawScore` / `score` / `level` / `signals[]` / `reasons[]` / `capped` / `cap` / `stale` / `missing`). Memory can raise risk but never lower it. Cap = 14. Stale index (>30 days) halves the adjustment. `shrk contract`, `shrk agent graph`, `shrk view <role>`, and `shrk orchestrate --risk-aware` now pass `includeMemory: true` automatically. MCP `get_task_risk_report` accepts `includeMemory`.
- **Contract gates** — new `shrk contract check <contract.json> [--plan …] [--approval …]`, `shrk contract approve <contract.json> --by … --reason …`, `shrk contract status <contract.json> [--approval …]`. The check validates 7 gates: `human-approval`, `required-plan-review`, `forbidden-files`, `required-validations`, `public-api-review`, `risk-approval`, `memory-elevated-approval`. Approvals are HMAC-signed when `SHARKCRAFT_CONTRACT_SECRET` is set. Schema: `sharkcraft.agent-contract-approval/v1` and `sharkcraft.agent-contract-gate/v1`.
- **Opt-in apply gate** — `shrk apply <plan> --contract <contract.json> [--approval <approval.json>]` enforces the contract before writing. Without `--contract` apply behaviour is unchanged.
- **Unified handoff** — `shrk handoff "<task>"` accepts `--include-contract`, `--include-brief`, `--include-execution-graph`, `--include-memory`, `--include-plan-simulation <plan.json>`, plus `--role` / `--mode`. The packet now optionally folds in the agent contract summary, the memory-driven warnings, the execution graph summary, and a plan-simulation summary. Backwards-compatible: every R24 field is optional in the JSON envelope. MCP `create_agent_handoff` accepts the same flags (read-only).
- **Plan simulation diff** — `shrk plan simulate <plan.json> --diff [--max-diff-lines N]` now reports `beforeLineCount`/`afterLineCount`, an `operationDetail` field per op kind (`append` / `insert-after` / `insert-before` / `replace` / `export` / `create` / `skip` / `conflict`), and a unified-diff preview (truncated when long). HTML output wraps each diff in a static `<details>` block — still no JavaScript.
- **Execution graph DOT + query** — `shrk agent graph "<task>" --graph-format dot` emits Graphviz `digraph`. New `shrk agent graph query <graph.json> "<filter>:<value>"` (supports `blocks:<id>`, `kind:<x>`, `edge:<x>`, `text:<substring>`). MCP `query_execution_graph` (read-only).

### Safety

- MCP write-tool count unchanged: zero. All R24 MCP tools are read-only — `get_contract_status`, `create_contract_approval_preview` (preview only, never persists), `query_execution_graph`.
- `shrk contract approve` writes only to the `--output` path the user supplies. No implicit write locations.
- Apply contract gate is opt-in. The pre-R24 `shrk apply <plan>` flow is unchanged.

## [Unreleased] — agent contract + plan simulation v2 + repo memory + self-healing + execution graph (R23)

### Added

- **Agent contract** — `shrk contract "<task>" [--role …] [--mode …]` builds a deterministic safety contract per task: allowed/forbidden files, allowed/forbidden commands, required validations / reviews / plan reviews, human approval gates, rollback plan, definition of done, relevant constructs / policies / boundaries / playbooks / templates, public-API risks, ownership review. Output as text / markdown / html / json. `--save` writes only under `.sharkcraft/contracts/`. MCP: `create_agent_contract` (read-only). Schema: `sharkcraft.agent-contract/v1`.
- **Plan simulation v2** — `shrk plan simulate <plan.json>` loads v1/v2 saved plans, reconstructs virtual contents when possible, classifies each operation (`ready` / `skip-idempotent` / `conflict` / `modifies-existing` / `creates-new`), and reports apply readiness (`ready / ready-with-review / blocked-conflicts / blocked-policy / blocked-boundary / blocked-signature / blocked-missing-review`). Detects public-API / barrel-export / feature-key-table / event-registry / token-registry / adapter-boundary / policy-owned / ownership-review touches. Flags: `--strict`, `--include-boundaries`, `--include-impact`, `--include-tests`, `--include-policies`, `--include-ownership`, `--include-memory`. Output as text / markdown / html / json. MCP: `simulate_plan` (read-only). Schema: `sharkcraft.plan-simulation/v1`.
- **Repo memory (local-only)** — `shrk memory build|report|risk|files|diagnostics|reset` produces a private, deterministic index at `.sharkcraft/memory/index.json` summarising frequently touched files, plans with conflicts, recurring boundary / policy violations, failed / slow validation commands, release blockers, pack issues, playbook outcomes, and high-activity constructs. `memory build` writes only to `.sharkcraft/memory/`; `memory reset` is dry-run by default and `--write` refuses to step outside `.sharkcraft/memory/`. **No network, no telemetry, no embeddings.** MCP: `get_memory_report`, `get_memory_risk`, `list_memory_files`, `get_memory_diagnostics` (all read-only). Schema: `sharkcraft.memory/v1`.
- **Self-healing plans** — `shrk heal from-error|from-file|from-report|from-command` builds an advisory `IHealingPlan` (likely causes, safe recovery steps, forbidden quick fixes, recommended commands, related docs / constructs, human-approval flag, next safest command). Reuses the existing diagnostics registry. Never auto-fixes, never writes source. MCP: `create_healing_plan` (read-only). Schema: `sharkcraft.healing-plan/v1`.
- **Task execution graph** — `shrk agent graph "<task>"` builds a typed node/edge graph that combines intent, risk, memory, contract, constructs, policies, boundaries, playbooks, templates, plans, review gates, human approval, validations, report artefacts, and done. Renderers: text / markdown / json / mermaid / html (HTML embeds the Mermaid source without JS). MCP: `create_execution_graph` (read-only). Schema: `sharkcraft.execution-graph/v1`.

### Safety

- MCP write-tool count unchanged: zero. All R23 MCP tools are read-only and registered in the audit list.
- `shrk contract --save` and `shrk memory build` write only inside `.sharkcraft/contracts/` and `.sharkcraft/memory/` respectively.
- `shrk heal` never auto-fixes and explicitly forbids `--no-verify` / silencing tests / committing secrets / deleting session state to "recover".
- All new commands are deterministic — no model calls, no network, no embeddings.

### Catalog

- 13 new entries in `packages/cli/src/commands/command-catalog.ts` covering `contract`, `plan simulate`, `memory *`, `heal *`, `agent graph`. `shrk commands doctor` reports the catalog as consistent.

## [Unreleased] — migration readiness + plan-review v2 surface (R22)

### Added

- **Migration readiness gates** — `shrk migration readiness --profile <id>` produces a deterministic, read-only verdict for multi-phase migrations. First profile gates the deletion of a legacy adopter CLI on signed pack + drift baseline + dedupe + script migration + MCP separation + retirement runbook. Verdict is one of `blocked`, `ready-except-{signing,baseline,dedupe,script-switch}`, `ready-to-deprecate`, `ready-to-delete`. Profiles are data-driven so new ones land without engine changes. MCP: `get_migration_readiness`, `list_migration_profiles`.
- **`shrk migration profiles`** — lists registered profiles (read-only).
- **Plan-review v2 kinds surfaced** — `shrk plan review <plan.json>` now renders `append` / `insert-after` / `insert-before` / `replace` / `export` entries with their own labels (previously collapsed to `unknown`). New `modifiesExisting: boolean` per file entry; summary counts (`creates`, `modifies existing`, `conflicts`); explicit `HUMAN REVIEW REQUIRED — N entry/entries modify existing files.` notice when N > 0.
- **Report-site construct page fix** — `shrk report site` now warms the construct cache before rendering. Repos whose constructs come via packs get a populated `constructs.html` instead of the authoring-guidance placeholder.

### Changed

- `IPlanReviewFile['type']` widened to include the v2 kinds (`append`, `insert-after`, `insert-before`, `replace`, `export`). Backwards-compatible: existing v1 plans continue to classify as `create` / `update` / `skip` / `conflict` / `unknown`.
- A representative adopter pack now ships 20 constructs (was 8) and 18 playbooks (was 10) — new constructs cover plugin-key-registry, default-registrar, plugin-defaults, event-registry, token, component-api, capability-registry, policy-registry, adapter-registry, effect-boundary, public-entrypoint, kernel-service. New playbooks: review-plugin-architecture, refactor-plugin-api-safely, migrate-legacy-cli-output, fix-boundary-violation, repair-exports, release-gate, cli-retirement-readiness, add-smarttable-feature.
- Adopter local policies extended from 1 → 7 — guards for feature-key changes, event-registry mutations, adapter business-logic mix, non-public-entrypoint barrels, forbidden layer mix, CLI retirement preconditions.

### Safety

- MCP write tool count unchanged: zero.
- Migration readiness is read-only — probes local files / env vars / pack manifest existence. Never runs source.
- All new policies are `severity: warning`, `checkType: plan`. None executes commands.
- Plan-review classifier change does not alter what `shrk apply` will write — only the review surface.

## [Unreleased] — per-task risk + graph resolution + evidence hardening (R20)

### Added

- **Per-task risk model** — `shrk risk "<task>" [--files a,b,c] [--since <ref>] [--staged] [--json] [--explain]` produces an `ITaskRiskReport` derived from change intent + impact analysis + architecture signals + boundary violations + ownership impact + tests. Surfaces `riskLevel` (low/medium/high/critical), `affectedFiles`, `highFanInFiles`, `highFanOutFiles`, `ownershipGaps`, `testGaps`, `boundaryConcerns`, `policyConcerns`, `recommendedReviewCommands`, `humanApprovalRequired`. MCP `get_task_risk_report`.
- **Task risk in orchestration / brief / handoff** — `shrk orchestrate "<task>" --risk-aware` now computes both global and per-task risk; high/critical task risk injects the `risk-review` phase. Briefs attach `taskRisk` when a task is supplied. Handoffs include a `taskRiskSummary` block.
- **Task-aware role views** — `shrk view <role> --task "<task>"` returns a personalised top-command list, task-specific risks, "what not to do" and "human approval points". Supports developer/reviewer/architect/release-manager/security/ai-agent. MCP `get_role_view` accepts `task?: string`.
- **Tsconfig path-aware intelligence graph** — `shrk intelligence graph|stats|query --resolve-aliases` resolves `@shrkcrft/...` (and any other tsconfig path alias) to file edges. Edges include `resolvedVia: 'literal' | 'tsconfig-path'`; truncation block surfaces `aliasResolvedEdges`. MCP `query_repository_intelligence` accepts `resolveAliases?: boolean`.
- **Intelligence query DSL v2** — `shrk intelligence query "<expr>"` accepts `AND` (implicit, space), `OR` (literal), `not:<filter>`. Examples: `kind:package OR kind:test`, `kind:file not:tag:test`. `--explain` prints the parsed expression.
- **Architecture violations diff** — `shrk architecture violations [--since <ref>] [--staged] [--files a,b,c] [--baseline <json>] [--format text|markdown|html|json]`. Classifies each violation as `existing-touched` / `new-in-changed-file` / `resolved` / `unknown`. MCP `get_architecture_violations_diff`.
- **Compliance evidence v2** — `shrk compliance evidence <profileId> [--zip] [--sign] [--verify <dir|manifest>]`. Manifest now includes per-file SHA-256 + SharkCraft version + git commit (when available). `--sign` adds an HMAC-SHA256 signature via `SHARKCRAFT_EVIDENCE_SECRET`. `--zip` produces a `.tar.gz` when `tar` is available locally and gracefully degrades otherwise. `--verify` checks file hashes and the signature (when set).
- **Policy override audit auto-record** — `shrk policy run --record-override-audit` appends the applied overrides to `.sharkcraft/policy-override-audit.log` (only when there is at least one applied override). `shrk policy overrides audit --format text|markdown|json`.
- **Reposet doctor real signals** — `shrk reposet map [--parallel]` / `shrk reposet doctor` now populate per-repo `doctor.{ok,warnings,errors,info}`, `boundaryRules`, `policyOverrides`, `verificationCommands`, `templates`, `pipelines`, and `lastInspectionError` (when inspection fails).
- **Command taxonomy docs builder** — `shrk commands taxonomy --write-docs [--output docs/commands-taxonomy.md]` writes the live taxonomy as markdown. The product check now warns when the doc is absent.
- **Product check v2** — `shrk product check [--strict]` adds: CHANGELOG has a current or Unreleased entry; README links release notes / limitations / external quickstart; release notes carry a "not production stable" disclaimer; `docs/commands-taxonomy.md` is present when expected. `--strict` converts warnings to errors. `shrk release readiness --with-product-check` folds the report into readiness.
- **API report public surface diff** — `shrk api report --snapshot <file>` compares against a prior report; `--write-snapshot <file>` captures one. `shrk api diff <old> <new>` for an explicit diff. Output includes added/removed exports, metadata changes, and breaking-change suspects.
- **Pack quality delta** — `shrk packs quality <path> --snapshot|--write-snapshot` and `shrk packs quality-diff <old> <new>` for score / dimension / signature deltas.
- **Dashboard export delta** — `shrk dashboard export --compare-with <oldDir>` and `shrk dashboard diff <oldDir> <newDir>`. Compares packs / commands / graph nodes / graph edges / architecture risks / boundary violations + per-section byte sizes. No server, no upload.
- New MCP tools: `get_task_risk_report`, `get_architecture_violations_diff` (in addition to the R19 `get_role_view` augmentation).

### Changed

- `IRepositoryEdge` adds optional `resolvedVia` (`'literal' | 'tsconfig-path'`); set only on imports edges. Truncation block adds `aliasResolvedEdges`.
- `IRepoSetMapEntry` adds `boundaryRules / policyOverrides / verificationCommands / templates / pipelines / lastInspectionError` and a richer `doctor.info` count.
- `IAgentOrchestrationPlan` adds optional `taskRisk` (per-task ITaskRiskReport when riskAware).
- `IAgentBrief` adds optional `taskRisk` when a task is supplied.
- `IAgentHandoffReport` adds optional `taskRiskSummary`.
- `IProductCoherenceReport` adds `strict: boolean`.

### Safety

- All new MCP tools are read-only.
- Compliance evidence writes only into the supplied output directory; `--sign` requires an explicit secret, `--verify` is read-only.
- Policy override audit only writes when explicitly requested (`--record-override-audit`); the `audit` subcommand is read-only.
- Dashboard diff does not start a server.

## [Unreleased] — intelligence quality + risk-aware coherence (R19)

### Added

- **Repository intelligence graph v3** — `shrk intelligence graph --include-imports` adds real `imports` / `depends-on` / `tests` edges by feeding `scanImports` and the workspace package map into the graph. Edge-kind summary in `intelligence stats`. Truncation surfaces `importEdges` / `importEdgeCap` / `importEdgesCapped`.
- **Graph query lite** — `shrk intelligence query "<filters>"` with `kind:` / `edge:` / `imports:` / `depends-on:` / `text:` / `tag:` / `package:` / `construct:`. MCP `query_repository_intelligence`.
- **Architecture map v3** — `shrk architecture map --signals` runs the real boundary evaluator and folds the result + high-impact (fan-in / fan-out) into the map. New `shrk architecture violations` and `shrk architecture area <id>`. MCP `get_architecture_violations`, `get_architecture_area`.
- **Risk-aware orchestration** — `shrk orchestrate "<task>" --risk-aware` injects a `risk-review` phase before `plan` when boundary violations / unsigned packs / missing tests push risk to high/critical. Forbidden actions and review checkpoints adjust accordingly. MCP `create_agent_orchestration_plan` accepts `riskAware?: boolean`. New `get_risk_signals` MCP tool.
- **Compliance evidence packets** — `shrk compliance evidence <profileId> [--output <dir>]` writes the compliance report + folds in already-generated safety / release-readiness / packs / quality / smoke / self-audit JSON, plus a manifest. MCP `preview_compliance_evidence_packet`.
- **Policy override audit trail** — `shrk policy overrides` and `shrk policy overrides audit`. Append-only log at `.sharkcraft/policy-override-audit.log` (only written when explicitly invoked). MCP `get_policy_override_audit`.
- **Reposet parallel inspection** — `shrk reposet map --parallel [--concurrency N]` (default 4); order preserved deterministically; per-repo errors captured.
- **Golden output autopopulation** — `shrk examples golden --init` writes missing snapshots only; `--update` rewrites all; `--check` fails on missing/mismatch.
- **Command taxonomy** — `shrk commands taxonomy [--format text|markdown|json]` groups the catalog into Start here / Daily development / AI agent context / Review and impact / Architecture intelligence / Governance and compliance / Packs and ecosystem / CI and reports / Release readiness / Diagnostics and troubleshooting / Advanced. MCP `get_command_taxonomy`.
- **Product coherence check** — `shrk product check` verifies the README narrative + required docs + no "autonomous write agent" claim + MCP read-only statement. MCP `get_product_coherence`.
- **API report improvements** — `shrk api report --all`, `--public-only`, `--format html`.

### Changed

- `architecture map` JSON shape now exposes `boundaryViolations` as `{ ruleId, file, importSpecifier, severity, line, message }[]` (was `string[]`) plus a `boundaryViolationCounts` block. **Schema bumped to `sharkcraft.architecture-map/v2`** (no rename — same id, richer payload; consumers that only read the old fields keep working). The text/markdown/html renderers were extended.

### Safety

- All new MCP tools are read-only.
- Policy override audit only writes when invoked explicitly.
- Compliance evidence writes only into the supplied output directory.

## [Unreleased] — next-level AI-operable repository platform (R18)

### Added

- **Repository intelligence graph v2** (`shrk intelligence graph|node|path|explain|stats` + MCP `get_repository_intelligence_graph` / `_node` / `find_*_path` / `explain_*_node`). Unifies packages, files, constructs, templates, pipelines, presets, boundaries, packs, public-API surfaces, decisions.
- **Change intent model** (`shrk intent "<task>"` + MCP `classify_change_intent`). Deterministic kind/domains/likelyConstructs classifier with risk hints + suggested first command.
- **Agent orchestration planner** (`shrk orchestrate "<task>" --mode conservative|balanced|aggressive` + MCP `create_agent_orchestration_plan`). Read-only multi-phase plan with forbidden actions + review checkpoints.
- **Safe workflow simulation** (`shrk simulate "<task>" --playbook|--pipeline` + MCP `simulate_workflow`). Predicts what a workflow would do without executing anything.
- **Architecture map v2** (`shrk architecture map --include layers,constructs,boundaries,public-api,tests,ownership --risk` + MCP `get_architecture_map`). Layered + risk-aware on top of the intelligence graph.
- **Decision / ADR support** (`shrk decisions list|get|new|report` + MCP `list_decisions`, `get_decision`, `preview_decision_draft`). Dry-run drafts; only writes under `sharkcraft/decisions/` with `--write-draft`.
- **Compliance profiles** (`shrk compliance profiles|get|check|report` + MCP `list_compliance_profiles`, `run_compliance_check`). Built-in `ai-safe-development`, `signed-pack-workflow`, `review-gated-codegen`, `ci-governed-repository`.
- **Policy severity overrides**: `policyOverrides` field in `sharkcraft.config.ts` (`severity` / `enabled` / `reason`) folded into existing policy reports.
- **Pack quality + docs** (`shrk packs quality <path>` + `shrk packs docs <path>` + MCP `get_pack_quality_report`, `get_pack_docs_preview`).
- **Reposet (multi-repo)** (`shrk reposet init|list|doctor|map` + MCP `list_reposet`, `get_reposet_map`). Read-only across multiple local repository roots.
- **Role views** (`shrk view developer|reviewer|architect|release-manager|security|ai-agent` + MCP `get_role_view`).
- **Command recommender** (`shrk recommend "<query>" [--from-error <stderr>] [--role <r>]` + MCP `recommend_commands`).
- **Diagnostics suggest** (`shrk diagnostics suggest "<stderr>" | --from-file` + MCP `suggest_diagnostic`).
- **Dashboard data export** (`shrk dashboard export --output .sharkcraft/dashboard-data --include repository-map,architecture,...` + MCP `get_dashboard_export_preview`).
- **Golden output snapshot tests** (`shrk examples golden [--update]`).
- **Release train model** (`shrk release train list|new|status|report|readiness`, registered under the `train` group). Local planning; no auto-publish/tag.
- **Upgrade advisor** (`shrk upgrade check|plan` + MCP `get_upgrade_advice`). Read-only schema-version detector.
- **Deep safety audit** (`shrk safety audit --deep` + MCP `get_safety_audit_deep`). Report-site external JS scan, demo destructive lines, CI workflow permissions.
- **Public API report** (`shrk api report [--package <name>] [--format text|markdown|json]` + MCP `get_package_api_report`).
- **Catalog**: 35+ new entries for the R18 surface; `commands doctor` and `commands ux-check` remain 0/0.

### Safety

- All new MCP tools are read-only.
- `decisions new`, `dashboard export`, `train new`, `reposet init` are dry-run by default and only write into draft/output directories.
- Pack-contributed verification commands are still NOT auto-run.

## [Unreleased] — public alpha finalisation (R17)

### Added

- **Release smoke content assertions** (`shrk release smoke --assertions` —
  on by default; `--no-assertions` opts out). Per-step
  `stdout-contains` / `stderr-not-contains` / `file-exists` /
  `file-contains` / `json-path-exists` / `output-not-empty` checks; a
  failing assertion marks the step failed.
- **Release smoke matrix mode** (`shrk release smoke --matrix
  [--target sharkcraft,dogfood,synthetic,adopter]`). Adopter target
  skipped with a warning when `--adopter-root` /
  `SHARKCRAFT_ADOPTER_ROOT` is unset.
- **Tarball install smoke** (`shrk install smoke --tarball`). Delegates to
  `bun run release:smoke-test` so the published-shape contract stays
  canonical.
- **Self-audit auto-population** (`shrk self audit --run [--timeout-ms <n>]`).
  Spawns the underlying checks with a per-step timeout.
- **Diagnostics registry** with `shrk diagnostics list / get <code>` and
  MCP tools `get_diagnostic_for_code` + `list_diagnostics`.
- **Pack-compat report-site embed**: `shrk report site --pack-compat <json>`
  renders a `pack-compat.html` page (placeholder when the file is absent).
- **Commands UX consistency check** (`shrk commands ux-check`): audits
  descriptions, safety metadata, alias collisions, and primary catalog
  references.
- **Public alpha release notes** (`docs/releases/0.1.0-alpha.1.md`),
  **limitations** (`docs/public-alpha-limitations.md`), and a
  **public-alpha checklist** (`docs/public-alpha-checklist.md`).
- **External repo quickstart** (`docs/external-repo-quickstart.md`).
- **Dashboard summary fold-in**. `get_dashboard_summary` includes
  `releaseReadiness` and `releaseSmoke` (with `ageMs`) when local
  artifacts exist.

### Changed

- `release readiness --strict` now expects release notes, public alpha
  limitations, external quickstart, and `CHANGELOG.md` — missing entries
  become warnings (strict promotes to blocker).
- Preflight summaries older than `PREFLIGHT_STALE_AFTER_DAYS = 7` are
  flagged as a warning even when `passed: true`.

### Safety

- All new MCP tools are read-only.
- `release smoke --matrix` writes only into the per-scenario temp
  fixture or the user-supplied `--temp-dir`. The adopter target uses
  the adopter's own working tree but never touches files outside
  SharkCraft pack/config/session/baseline assets.

## [0.1.0-alpha.1] — 2026-05-12

### Positioning

SharkCraft makes repositories understandable and safer for AI coding
agents. It does **not** replace Claude Code, Cursor, Aider, or any other
agent — it stores your project's rules, paths, templates, workflows, and
knowledge in a typed format and serves only the relevant slice to agents
through MCP and to humans through a CLI.

### Status

**Alpha.** APIs may shift between alpha tags. Bun ≥ 1.1 is the primary
runtime. Pin exact versions in lockfiles; expect a few breaking changes
before `0.1.0`.

### What is included

- 18 packages under `@shrkcrft/*` published to npm.
- A working CLI binary (`shrk`).
- An MCP server with ~34 tools and read-only resources.
- A pack system (third-party knowledge packages) with discovery, signing,
  verification, and a doctor.
- An export system for compatibility files (AGENTS.md, CLAUDE.md, Cursor
  rules, Copilot instructions).
- An import system for the same formats (drafts only).
- Pipelines: declarative agent workflows that render as shell scripts.
- A dogfood example repo and a representative adopter pack snapshot.

### Safety model (unchanged from the design intent)

- **MCP is read-only.** No tool in the MCP surface writes files.
- **The CLI is the only write path.** `shrk apply` writes plans; `shrk gen
  --write` writes generators.
- **Generation is plan-first.** Dry-run by default. Paths are refused if
  they escape the project root.
- **Plan signing.** HMAC-SHA256 over canonical JSON with
  `SHARKCRAFT_PLAN_SECRET`. Tampering is detected on `shrk apply
  --verify-signature`.
- **Pack signing.** Same model for pack manifests via
  `SHARKCRAFT_PACK_SECRET`. Signed JSON manifests are loaded as data, not
  code.
- **Knowledge files are trusted local TS config.** Same trust model as
  `vite.config.ts` / `eslint.config.js`. Only install packs you trust.

### CLI highlights

- `shrk init` — scaffold a `sharkcraft/` folder.
- `shrk inspect` / `shrk doctor` — workspace and readiness inspection.
- `shrk doctor --strict[=errors|warnings|all] --min-score N` — CI gate.
- `shrk context --task "..."` — token-budgeted, filtered context for a task.
- `shrk rules relevant --task "..."` — only the matching rules.
- `shrk gen <template> <name> --dry-run --save-plan ...` — plan-first
  generation.
- `shrk apply <plan> [--verify-signature]` — single write path.
- `shrk export agents-md|claude-md|cursor-rules|copilot-instructions`
  — compatibility-file exports.
- `shrk import agents-md|claude-md|cursor-rules` — parse external files
  into draft knowledge modules (`sharkcraft/imports/<format>.draft.ts`).
- `shrk pipelines list|get|context|plan|script|next` — declarative
  workflows. `shrk pipeline` is an alias.
- `shrk packs list|get|inspect|doctor|sign|verify` — third-party pack
  management. `shrk pack` is an alias.
- `shrk mcp serve [--http] [--watch]` — start the MCP server (stdio or
  Streamable HTTP).

### MCP highlights

- ~34 tools across project overview, knowledge, rules, paths, templates,
  pipelines, packs, action hints, AI-readiness, and read-only resources.
- Built on `@modelcontextprotocol/sdk` (stdio + Streamable HTTP).
- Zod-validated input on every tool call.
- `notifications/resources/list_changed` fires when `--watch` is set and
  knowledge / templates / pipelines change on disk.
- **The MCP server never writes files** — `create_generation_plan` returns
  a dry-run plan that the human applies via the CLI.

### Pack system

- Discovery walks `node_modules/` for packages with a `sharkcraft` field
  in `package.json`. Manifests can be TypeScript modules
  (`./src/sharkcraft.plugin.ts`) or signed JSON
  (`./src/sharkcraft.plugin.signed.json`).
- Signed JSON manifests are read as data — never dynamic-imported.
- `shrk packs sign <manifest-or-folder> --key-id … --verify-after-sign`.
- `shrk packs verify [--required]` — fails on tampered or unsigned packs.
- `shrk packs doctor [--verify-signatures] [--require-signatures]` —
  invalid manifests, missing files, empty contributions, duplicate ids,
  template/pipeline quality, hint coverage, signature status.
- Resolved counts: every pack reports both declared contribution-file
  counts AND resolved object counts after dedup.
- Local entries always win on duplicate ids; pack contributions are
  reported as info/warning issues.

### Pipelines

- Declarative pipeline definitions live in `sharkcraft/pipelines.ts`.
- `shrk pipelines script <id> --task "..." --var k=v` renders a literal
  bash script the agent or a human can run line by line.
- Apply/write steps include a manual-confirm prompt.

### Import / export

- Imports always land as drafts under `sharkcraft/imports/`. Library APIs
  never write files.
- Exports default to dry-run preview; `--write` saves to a sensible
  default location.

### Known limitations

- Token estimator is a heuristic; the v0.2 plan is to swap in a real
  tokenizer.
- `bunx @shrkcrft/cli@alpha` works once `@shrkcrft/cli@0.1.0-alpha.1`
  is published; until then, use the local repo via `bun run shrk`.
- npm publishing requires `bump-versions` to write concrete `^x.y.z` pins
  in place of `workspace:*` — `publish-dry-run` and `install-smoke-test`
  already swap these in-flight, but the on-disk `package.json` keeps the
  dev `workspace:*` pin until a publishing run.
- The CLI ships a `shrk` bin; the MCP server is a library invoked via
  `shrk mcp serve` (no separate binary in alpha).
- Pack discovery scans `node_modules/` only; pnpm-style nested hoisting
  may not be picked up everywhere.

### Install / upgrade

```bash
# Once published (this is the alpha-1 form):
npm install -g @shrkcrft/cli@0.1.0-alpha.1
shrk --version  # → SharkCraft v0.1.0-alpha.1

# Quick try without a global install:
bunx @shrkcrft/cli@alpha init
bunx @shrkcrft/cli@alpha doctor
```

### Repo metadata

- 18 packages
- 190 tests across 34 files
- Typecheck green, build:dist green, publish-dry-run green,
  release-preflight green
- Dogfood readiness: 71 / 100 (good)
- Adopter readiness: 87 / 100 (excellent)
