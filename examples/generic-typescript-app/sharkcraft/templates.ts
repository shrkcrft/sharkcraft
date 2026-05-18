import { defineTemplate } from '@shrkcrft/templates';

export const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'TypeScript Service',
  description: 'Creates a generic TypeScript service class.',
  tags: ['typescript', 'service'],
  scope: ['typescript'],
  appliesWhen: ['generate-service'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file name' },
    { name: 'className', required: true, description: 'PascalCase class name' },
  ],
  targetPath: ({ name }) => `src/services/${name}.service.ts`,
  content: ({ className }) => `export class ${className} {
  init(): void {
    // initialization
  }
}
`,
  postGenerationNotes: ['Add tests next to the file (*.spec.ts) if it contains real logic.'],
});

export default [tsService];
