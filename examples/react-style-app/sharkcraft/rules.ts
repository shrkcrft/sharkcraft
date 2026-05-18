import { defineRule } from '@shrkcrft/rules';
import { KnowledgePriority } from '@shrkcrft/knowledge';

export const functionalOnly = defineRule({
  id: 'react.components.functional',
  title: 'Use functional components',
  priority: KnowledgePriority.High,
  scope: ['react'],
  tags: ['react', 'component'],
  appliesWhen: ['generate-component'],
  content: `Use functional components and hooks. Class components are not allowed.`,
});

export default [functionalOnly];
