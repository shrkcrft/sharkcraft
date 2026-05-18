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
});
