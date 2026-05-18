export const examplePath = {
  id: 'pack.example.path.utilities',
  title: 'Shared pack utilities (example)',
  type: 'path',
  priority: 'medium',
  scope: ['typescript'],
  tags: ['util', 'shared'],
  appliesWhen: ['generate-utility'],
  content: 'Pack-contributed convention: shared utilities live under src/lib/shared/.\nCanonical path: src/lib/shared',
  metadata: {
    path: 'src/lib/shared',
    description: 'Pack-contributed shared utility location.',
  },
};

export default [examplePath];
