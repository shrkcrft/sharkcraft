import { defineSharkCraftConfig } from '@shrkcrft/config';

export default defineSharkCraftConfig({
  projectName: 'angular-style-app',
  description: 'Angular-style consumer of SharkCraft (knowledge only).',
  knowledgeFiles: ['knowledge.ts'],
  ruleFiles: ['rules.ts'],
  pathFiles: ['paths.ts'],
  templateFiles: ['templates.ts'],
  docsFiles: ['docs/overview.md'],
  defaultScope: ['typescript', 'angular'],
});
