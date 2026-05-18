import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { KnowledgeIndex } from '@shrkcrft/knowledge';
import type { IContextRequest } from './context-request.ts';

export interface SelectedEntries {
  rules: IKnowledgeEntry[];
  paths: IKnowledgeEntry[];
  templates: IKnowledgeEntry[];
  architecture: IKnowledgeEntry[];
  technical: IKnowledgeEntry[];
  warnings: IKnowledgeEntry[];
  commands: IKnowledgeEntry[];
  testing: IKnowledgeEntry[];
  security: IKnowledgeEntry[];
  docs: IKnowledgeEntry[];
  tasks: IKnowledgeEntry[];
}

const TYPE_BUCKETS: Record<string, keyof SelectedEntries> = {
  rule: 'rules',
  path: 'paths',
  template: 'templates',
  architecture: 'architecture',
  technical: 'technical',
  warning: 'warnings',
  command: 'commands',
  testing: 'testing',
  security: 'security',
  task: 'tasks',
};

export function selectRelevantEntries(
  allEntries: readonly IKnowledgeEntry[],
  request: IContextRequest,
  limitPerSection = 5,
): SelectedEntries {
  const index = new KnowledgeIndex(allEntries);
  const tags: string[] = [...(request.tags ?? [])];
  const scope: string[] = [...(request.scope ?? [])];
  if (request.framework) scope.push(request.framework);
  if (request.area) scope.push(request.area);

  const searchAll = index.search({
    query: request.task,
    scope,
    tags,
    appliesWhen: request.appliesWhen,
  });

  const buckets: SelectedEntries = {
    rules: [],
    paths: [],
    templates: [],
    architecture: [],
    technical: [],
    warnings: [],
    commands: [],
    testing: [],
    security: [],
    docs: [],
    tasks: [],
  };

  for (const r of searchAll) {
    const typeKey = String(r.entry.type).toLowerCase();
    const bucketKey = TYPE_BUCKETS[typeKey];
    if (bucketKey) {
      if (buckets[bucketKey].length < limitPerSection) buckets[bucketKey].push(r.entry);
    } else if (request.includeDocs) {
      if (buckets.docs.length < limitPerSection) buckets.docs.push(r.entry);
    }
  }

  return buckets;
}
