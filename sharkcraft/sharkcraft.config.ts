// Self-dogfood SharkCraft config for the engine monorepo itself.
//
// This file is intentionally written as a plain default export rather than
// using `defineSharkCraftConfig` from `@shrkcrft/config`. The repo root has
// no `@shrkcrft/*` symlinks in its `node_modules/` (the workspace deps live
// inside each `packages/<x>/node_modules/`), so an absolute workspace import
// from here would fail to resolve. The loader at
// `packages/config/src/config-loader.ts` validates this object via zod and
// only requires the shape — no helper call is needed.

export default {
  projectName: 'sharkcraft-monorepo',
  description:
    'Self-dogfood SharkCraft configuration for the engine repository itself. Describes the monorepo to its own tooling so the dashboard, doctor, and MCP have a real workspace to read.',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  pipelineFiles: ['pipelines.ts'],
  boundaryFiles: ['boundaries.ts'],
  docsFiles: [],
  defaultMaxTokens: 3500,
  defaultScope: ['typescript', 'monorepo', 'engine'],
  // Commands available to `shrk apply --validate --verification <id>`. Only
  // entries marked `trusted: true` run by default. These are the checks a
  // contributor would run by hand anyway — wiring them here means `apply` can
  // gate on them automatically.
  verificationCommands: [
    {
      id: 'typecheck',
      label: 'TypeScript: noEmit typecheck (base config)',
      command: 'bun x tsc -p tsconfig.base.json --noEmit',
      trusted: true,
    },
    {
      id: 'unit-tests',
      label: 'Bun test suite',
      command: 'bun test',
      trusted: true,
    },
    {
      id: 'doctor',
      label: 'shrk doctor (config + entries health)',
      command: 'bun run shrk doctor',
      trusted: true,
    },
    {
      id: 'boundaries',
      label: 'shrk check boundaries (layer order enforcement)',
      command: 'bun run shrk check boundaries',
      trusted: true,
    },
  ],
  metadata: {
    selfDogfood: true,
    audience: 'engine-contributors',
    note: 'This is the SharkCraft engine repo, not a generic consumer. Knowledge entries / docs intentionally stay empty; rules, paths, templates, pipelines, and boundaries describe the monorepo layout and the canonical engine-development flow.',
  },
// surface.profile picked by `shrk init` (override): no high-signal profile match — fell back to the default developer profile.
  surface: {
    profile: "developer",
    enabled: [],
    hidden: [],
  },
};
