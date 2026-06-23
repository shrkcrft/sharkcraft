import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { KnowledgeIndex } from '@shrkcrft/knowledge';
import type { IContextRequest } from './context-request.ts';
import { deriveAppliesWhen } from './derive-applies-when.ts';

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

  // Merge any explicit appliesWhen with tokens derived from the task verbs /
  // domain so foundational rules that key on `appliesWhen` (e.g.
  // architecture.layer-order on 'generate-code') earn a match reason for a task
  // whose wording doesn't overlap the rule. Without this they score 0 reasons
  // and are dropped before priority matters.
  const appliesWhen = [
    ...new Set([...(request.appliesWhen ?? []), ...deriveAppliesWhen(request.task)]),
  ];

  const searchAll = index.search({
    query: request.task,
    scope,
    tags,
    appliesWhen,
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
