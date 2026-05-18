import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'generic-typescript-app',
  description: 'A small TypeScript app instrumented with SharkCraft.',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  docsFiles: ['docs/overview.md', 'docs/architecture.md', 'docs/quick-start.md'],
  defaultMaxTokens: 3000,
  defaultScope: ['typescript'],
});
