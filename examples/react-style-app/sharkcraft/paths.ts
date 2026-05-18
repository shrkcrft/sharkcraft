import { definePathConvention } from '@shrkcrft/paths';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const components = definePathConvention({
  id: 'react.components',
  title: 'React components',
  path: 'src/components',
  description: 'Reusable React components.',
  priority: KnowledgePriority.High,
  scope: ['react'],
  tags: ['component'],
  appliesWhen: ['generate-component'],
});

export const hooks = definePathConvention({
  id: 'react.hooks',
  title: 'React hooks',
  path: 'src/hooks',
  description: 'Custom hooks.',
  priority: KnowledgePriority.Medium,
  scope: ['react'],
  tags: ['hook'],
  appliesWhen: ['generate-hook'],
});

export default [components, hooks];
