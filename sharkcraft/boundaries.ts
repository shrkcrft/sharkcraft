// Boundary rules for the SharkCraft engine monorepo.
//
// Two rules only — each one catches a *class* of layer-order violation that
// would otherwise have to be spotted in code review. Verified at write time
// against the current source tree: both rules are passing.
//
// The glob matcher in `packages/boundaries/src/scan/glob.ts` supports `**`,
// `*`, `?` only (no extglob `!(...)`). `from` patterns match file paths
// relative to the project root; `forbiddenImports` patterns match the
// literal import specifier.
//
// Plain default-exported array (no `@shrkcrft/boundaries` import — see
// sharkcraft.config.ts).

export default [
  {
    id: 'core.is-base-layer',
    title: 'core is the base layer — must not import any other @shrkcrft package',
    description:
      'core sits at the bottom of the dependency graph. It defines IDs, Result, AppError, and tiny shared primitives. Importing any other @shrkcrft/* from core would create a cycle the moment that package depends on core (which they all do).',
    severity: 'error',
    from: ['packages/core/src/**'],
    forbiddenImports: ['@shrkcrft/*'],
    tags: ['layer-order', 'engine'],
    appliesWhen: ['review-code', 'create-feature'],
    message:
      'packages/core/src/** must not import from any other @shrkcrft/* package. core is the base layer; everything else depends on it.',
    suggestedFix:
      'Move the symbol you need into @shrkcrft/core, OR move the consuming code out of @shrkcrft/core into a higher layer.',
    relatedRules: ['repo.architecture.respect-layer-order'],
    relatedPathConventions: ['engine.packages'],
  },
  {
    id: 'dashboard.browser-bundle-purity',
    title: 'dashboard (browser bundle) must not import server-only @shrkcrft packages',
    description:
      'packages/dashboard ships a Vite-built browser bundle. It must only consume types from @shrkcrft/dashboard-api. Importing any node:fs-using package (workspace, config, inspector, generator, packs, importer, mcp-server, cli) breaks the browser build at best and ships server code to the client at worst.',
    severity: 'error',
    from: ['packages/dashboard/src/**'],
    forbiddenImports: [
      '@shrkcrft/workspace',
      '@shrkcrft/config',
      '@shrkcrft/packs',
      '@shrkcrft/generator',
      '@shrkcrft/importer',
      '@shrkcrft/inspector',
      '@shrkcrft/mcp-server',
      '@shrkcrft/cli',
    ],
    tags: ['layer-order', 'dashboard', 'browser-safety'],
    appliesWhen: ['review-code', 'create-feature'],
    message:
      'packages/dashboard/src/** is a browser bundle. It must only import @shrkcrft/dashboard-api (types) and external browser-safe deps.',
    suggestedFix:
      'If the dashboard needs server data, route it through the dashboard-api contract. Add a new field to @shrkcrft/dashboard-api and have the CLI-side server populate it.',
    relatedRules: ['repo.architecture.respect-layer-order', 'repo.safety.mcp-is-read-only'],
    relatedPathConventions: ['engine.packages'],
  },
];
