import { defineKnowledgeEntry, KnowledgeType, KnowledgePriority } from '@shrkcrft/knowledge';

export const projectOverview = defineKnowledgeEntry({
  id: 'project.overview',
  title: 'Project Overview',
  type: KnowledgeType.Architecture,
  priority: KnowledgePriority.High,
  scope: ['typescript'],
  tags: ['overview'],
  appliesWhen: ['onboard'],
  content: `Generic TypeScript app. Source code lives under src/. SharkCraft knowledge
lives under sharkcraft/. Use shrk to retrieve only what you need.`,
});

export const generationSafety = defineKnowledgeEntry({
  id: 'safety.generation',
  title: 'Generation safety',
  type: KnowledgeType.Warning,
  priority: KnowledgePriority.Critical,
  scope: ['generation'],
  tags: ['safety'],
  appliesWhen: ['generate-code'],
  content: `Never write files without --write and a conflict-free plan. Never
modify files outside the project root.`,
});

export default [projectOverview, generationSafety];
