import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'dogfood-target',
  description:
    'A realistic Bun-native TypeScript HTTP service used to dogfood SharkCraft from an external-feeling repo.',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  pipelineFiles: ['pipelines.ts'],
  docsFiles: ['docs/overview.md', 'docs/architecture.md', 'docs/development.md'],
  defaultMaxTokens: 3500,
  defaultScope: ['typescript', 'bun', 'backend'],

  // Deterministic verification commands `shrk apply --validate` / `shrk delegate`
  // are allowed to run. Only ids listed here are eligible — a pack can never
  // inject one.
  verificationCommands: [
    {
      id: 'barrel-tsc',
      label: 'Typecheck after a barrel edit',
      command: 'bun x tsc -p tsconfig.json --noEmit',
    },
  ],

  // Local-LLM delegate worker (see `shrk delegate`). The one MVP recipe lets a
  // local model add a re-export line to a barrel index — fenced to barrel files,
  // limited to export/ensure-import ops, and verified by `barrel-tsc`.
  delegation: {
    enabled: true,
    provider: 'auto',
    recipes: [
      {
        id: 'add-barrel-export',
        title: 'Add a re-export line to a barrel index',
        guardrailGlobs: ['src/**/index.ts'],
        allowedOps: ['export', 'ensure-import'],
        verificationIds: ['barrel-tsc'],
        riskCeiling: 'low',
      },
      {
        id: 'ensure-import',
        title: 'Add a missing import for an already-used symbol',
        guardrailGlobs: ['src/**/*.ts'],
        allowedOps: ['ensure-import'],
        verificationIds: ['barrel-tsc'],
        riskCeiling: 'low',
      },
    ],
  },
});
