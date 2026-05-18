import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const angularStyle = defineKnowledgeEntry({
  id: 'angular.style',
  title: 'Angular style conventions',
  type: KnowledgeType.Convention,
  priority: KnowledgePriority.High,
  scope: ['angular', 'typescript'],
  tags: ['angular', 'style'],
  appliesWhen: ['generate-component', 'review-code'],
  content: `Components: PascalCase + suffix Component. Services: PascalCase + suffix Service.
Templates and styles in separate files (templateUrl, styleUrls). Selectors are kebab-case
with a short app-specific prefix.`,
});

export default [angularStyle];
