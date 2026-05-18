import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const reactStyle = defineKnowledgeEntry({
  id: 'react.style',
  title: 'React style conventions',
  type: KnowledgeType.Convention,
  priority: KnowledgePriority.High,
  scope: ['react', 'typescript'],
  tags: ['react', 'style'],
  appliesWhen: ['generate-component', 'review-code'],
  content: `Functional components only. PascalCase file basenames for components.
Hooks live under hooks/. Test files use .test.tsx.`,
});

export default [reactStyle];
