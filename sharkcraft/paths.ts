// Root-level path conventions for the SharkCraft engine monorepo.
//
// Plain default-exported array (no `@shrkcrft/paths` import — see
// sharkcraft.config.ts for the reason). Each entry uses `type: 'path'` and
// declares the canonical path in `metadata.path`, matching what
// `definePathConvention` would produce in
// `packages/paths/src/path-convention.ts`.
//
// `references` make each convention verifiable by `shrk knowledge
// stale-check`: a path entry names directories, so it pins them (and the
// canonical files its description names). An entry with no references is
// counted UNVERIFIABLE — never healthy.

export default [
  {
    id: 'engine.packages',
    title: 'Engine packages',
    type: 'path',
    priority: 'critical',
    scope: ['monorepo', 'engine'],
    tags: ['source', 'workspace'],
    appliesWhen: ['create-feature', 'generate-code', 'review-code'],
    content:
      'All engine source lives under packages/<name>/src/. Each package publishes from packages/<name>/dist/. Layer order is enforced — see repo.architecture.respect-layer-order.',
    metadata: {
      path: 'packages',
      description:
        'Workspace packages (core, workspace, config, knowledge, rules, paths, templates, pipelines, presets, boundaries, packs, generator, importer, inspector, mcp-server, cli, dashboard, dashboard-api, ai, shared, plugin-api).',
    },
    references: [
      { kind: 'directory', path: 'packages' },
      { kind: 'directory', path: 'packages/core/src' },
      { kind: 'directory', path: 'packages/cli/src' },
    ],
    verifiedOn: '2026-09-11',
    actionHints: {
      mcpTools: [
        { tool: 'check_boundaries', purpose: 'Confirm any new cross-package import respects layer order.' },
        { tool: 'get_import_graph_analysis', purpose: 'Inspect concrete import edges between packages.' },
      ],
      relatedKnowledge: ['repo.architecture.respect-layer-order'],
    },
  },
  {
    id: 'engine.examples',
    title: 'Dogfood and E2E example targets',
    type: 'path',
    priority: 'medium',
    scope: ['monorepo', 'examples'],
    tags: ['examples', 'dogfood'],
    appliesWhen: ['onboard', 'create-feature', 'generate-test'],
    content:
      'Consumer-shaped fixture repos used by tests and to dogfood the engine from an external-feeling angle. dogfood-target/ is the canonical reference for a complete consumer sharkcraft/ setup.',
    metadata: {
      path: 'examples',
      description:
        'unconfigured-bun-service/, dogfood-target/, dashboard-e2e-target/. Treat these as black-box consumers, not engine internals.',
    },
    references: [
      { kind: 'directory', path: 'examples/dogfood-target/sharkcraft' },
      { kind: 'directory', path: 'examples/unconfigured-bun-service' },
      { kind: 'directory', path: 'examples/dashboard-e2e-target' },
    ],
    verifiedOn: '2026-09-11',
  },
  {
    id: 'engine.docs',
    title: 'Authoritative documentation',
    type: 'path',
    priority: 'medium',
    scope: ['docs'],
    tags: ['docs'],
    appliesWhen: ['add-docs', 'create-feature', 'review-code'],
    content:
      'Long-form, canonical docs. Each concept gets one file; cross-link from overview.md. Code changes that affect behavior must update or add the corresponding doc.',
    metadata: {
      path: 'docs',
      description:
        'overview, philosophy, onboarding, inference, security, safety-model, dashboard, dashboard-api, testing, release-checklist, etc.',
    },
    references: [
      { kind: 'directory', path: 'docs' },
      { kind: 'file', path: 'docs/overview.md' },
      { kind: 'file', path: 'docs/philosophy.md' },
    ],
    verifiedOn: '2026-09-11',
  },
  {
    id: 'engine.e2e',
    title: 'Playwright end-to-end suite',
    type: 'path',
    priority: 'medium',
    scope: ['testing', 'e2e'],
    tags: ['testing', 'playwright'],
    appliesWhen: ['generate-test', 'review-code'],
    content:
      '*.e2e.ts specs that drive the dashboard against examples/dashboard-e2e-target/. Not picked up by `bun test`; run via `bun run test:e2e:dashboard` or `release:preflight --with-e2e`.',
    metadata: {
      path: 'e2e',
      description: 'Playwright suites. Includes the read-only safety contract.',
    },
    references: [
      { kind: 'directory', path: 'e2e' },
      { kind: 'directory', path: 'examples/dashboard-e2e-target' },
      { kind: 'file', path: 'e2e/20-read-only-safety.e2e.ts' },
      { kind: 'file', path: 'package.json', contains: '"test:e2e:dashboard"' },
      { kind: 'file', path: 'scripts/release-preflight.ts', contains: "'--with-e2e'" },
    ],
    verifiedOn: '2026-09-11',
  },
  {
    id: 'engine.scripts',
    title: 'Release and build tooling',
    type: 'path',
    priority: 'medium',
    scope: ['tooling', 'release'],
    tags: ['release', 'build'],
    appliesWhen: ['release', 'review-code'],
    content:
      'Release preflight, dist builds, and publish helpers. Touch these only when changing the release pipeline; never as part of a feature change.',
    metadata: {
      path: 'scripts',
      description: 'release-preflight, build-dist, publish-* tooling.',
    },
    references: [
      { kind: 'directory', path: 'scripts' },
      { kind: 'file', path: 'scripts/release-preflight.ts' },
      { kind: 'file', path: 'scripts/build-dist.ts' },
      { kind: 'file', path: 'scripts/publish-packages.ts' },
    ],
    verifiedOn: '2026-09-11',
  },
];
