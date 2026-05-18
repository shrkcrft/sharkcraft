export const exampleTemplate = {
  id: 'pack.example.greeting',
  name: 'Pack greeting',
  description: 'A trivial pack-contributed template that creates a hello function under src/utils/.',
  tags: ['example', 'pack'],
  scope: ['typescript'],
  appliesWhen: ['generate-utility'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case filename' },
  ],
  targetPath: ({ name }) => `src/utils/${name}-greeting.ts`,
  content: ({ name }) => `export function ${name.replace(/[^a-z0-9]/gi, '')}Greeting(): string {\n  return 'hello from pack-example';\n}\n`,
  postGenerationNotes: ['Replace this stub with a real implementation when needed.'],
};

export default [exampleTemplate];
