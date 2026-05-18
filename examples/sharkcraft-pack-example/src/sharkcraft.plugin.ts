// Example SharkCraft pack manifest. The pack ships a small body of
// knowledge / rules / paths / templates / pipelines that a consumer repo
// picks up automatically when this package is installed.

import { definePackManifest } from '@shrkcrft/plugin-api';

export default definePackManifest({
  schema: 'sharkcraft.pack/v1',
  info: {
    name: '@example/sharkcraft-pack-example',
    version: '0.1.0',
    description: 'Example SharkCraft pack — demonstrates discovery + contributions.',
    author: 'SharkCraft contributors',
    license: 'MIT',
  },
  contributions: {
    knowledgeFiles: ['./src/assets/knowledge.ts'],
    ruleFiles: ['./src/assets/rules.ts'],
    pathFiles: ['./src/assets/paths.ts'],
    templateFiles: ['./src/assets/templates.ts'],
    pipelineFiles: ['./src/assets/pipelines.ts'],
    docsFiles: ['./src/assets/docs/overview.md'],
  },
  postInstallNotes: [
    'Run `shrk packs list` to verify the pack was discovered.',
    'Pack contributions are surfaced alongside the consuming repo own sharkcraft/ files; local entries always win on duplicate ids.',
  ],
});
