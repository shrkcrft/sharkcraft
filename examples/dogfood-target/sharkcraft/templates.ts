import { defineTemplate } from '@shrkcrft/templates';

export const tsService = defineTemplate({
  id: 'typescript.service',
  name: 'TypeScript Service',
  description: 'Creates a Bun-friendly service class under src/services/.',
  tags: ['typescript', 'service'],
  scope: ['typescript', 'backend'],
  appliesWhen: ['generate-service', 'create-business-logic'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file name (e.g. user-profile)' },
    {
      name: 'className',
      required: true,
      pattern: /^[A-Z][A-Za-z0-9]*$/,
      description: 'PascalCase class name (e.g. UserProfileService)',
    },
  ],
  targetPath: ({ name }) => `src/services/${name}.service.ts`,
  content: ({ className }) => `export class ${className} {
  init(): void {
    // initialization
  }
}
`,
  postGenerationNotes: [
    'Wire the new service into src/server.ts when it should be exposed.',
    'Add a *.spec.ts in tests/ if it contains real business logic.',
  ],
  related: ['typescript.naming.classes', 'app.services'],
});

export const tsUtility = defineTemplate({
  id: 'typescript.utility',
  name: 'Pure utility',
  description: 'Creates a pure utility module under src/utils/.',
  tags: ['typescript', 'utility'],
  scope: ['typescript'],
  appliesWhen: ['generate-utility'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file name' },
    { name: 'camel', required: true, description: 'camelCase function name' },
  ],
  targetPath: ({ name }) => `src/utils/${name}.ts`,
  content: ({ camel }) => `export function ${camel}(input: unknown): unknown {
  return input;
}
`,
  postGenerationNotes: ['Keep utilities pure. Tests live in tests/.'],
  related: ['typescript.files.one-export'],
});

export const tsTest = defineTemplate({
  id: 'typescript.test',
  name: 'Bun test file',
  description: 'Creates a bun:test test file mirroring src/ layout.',
  tags: ['typescript', 'test'],
  scope: ['testing'],
  appliesWhen: ['generate-test'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case basename of the unit under test' },
    { name: 'pascal', required: true, description: 'PascalCase label for describe()' },
  ],
  targetPath: ({ name }) => `tests/${name}.spec.ts`,
  content: ({ pascal }) => `import { describe, expect, test } from 'bun:test';

describe('${pascal}', () => {
  test('placeholder', () => {
    expect(true).toBe(true);
  });
});
`,
  related: ['testing.target-services'],
});

export const tsFeatureFolder = defineTemplate({
  id: 'typescript.feature',
  name: 'Feature folder',
  description: 'Creates a vertical feature slice (service + types + index re-export).',
  tags: ['typescript', 'feature'],
  scope: ['typescript', 'backend'],
  appliesWhen: ['generate-feature'],
  variables: [
    { name: 'name', required: true },
    { name: 'pascal', required: true },
  ],
  files: ({ name, pascal }) => [
    {
      targetPath: `src/features/${name}/index.ts`,
      content: `export * from './${name}.service.ts';\nexport * from './${name}.types.ts';\n`,
    },
    {
      targetPath: `src/features/${name}/${name}.service.ts`,
      content: `import type { I${pascal}Config } from './${name}.types.ts';\n\nexport class ${pascal}Service {\n  constructor(private readonly config: I${pascal}Config) {}\n}\n`,
    },
    {
      targetPath: `src/features/${name}/${name}.types.ts`,
      content: `export interface I${pascal}Config {\n  enabled: boolean;\n}\n`,
    },
  ],
  postGenerationNotes: ['Add tests under tests/features/<name>.'],
});

export default [tsService, tsUtility, tsTest, tsFeatureFolder];
