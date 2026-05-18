import { defineTemplate } from '@shrkcrft/templates';

export const reactComponent = defineTemplate({
  id: 'react.component',
  name: 'React Component',
  description: 'Functional React component skeleton.',
  tags: ['react', 'component'],
  scope: ['react'],
  appliesWhen: ['generate-component'],
  variables: [
    { name: 'name', required: true, description: 'kebab-case file basename' },
    { name: 'pascal', required: true, description: 'PascalCase component name' },
  ],
  files: ({ name, pascal }) => [
    {
      targetPath: `src/components/${name}/${pascal}.tsx`,
      content: `interface I${pascal}Props {
  label?: string;
}

export function ${pascal}({ label = '${pascal}' }: I${pascal}Props): JSX.Element {
  return <div>{label}</div>;
}
`,
    },
    {
      targetPath: `src/components/${name}/index.ts`,
      content: `export * from './${pascal}.tsx';\n`,
    },
  ],
});

export default [reactComponent];
