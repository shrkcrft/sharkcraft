import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { KnowledgeIndex } from '@shrkcrft/knowledge';
import type { IContextRequest } from './context-request.ts';
import { deriveAppliesWhen } from './derive-applies-when.ts';

export interface SelectedEntries {
  rules: IKnowledgeEntry[];
  paths: IKnowledgeEntry[];
  templates: IKnowledgeEntry[];
  architecture: IKnowledgeEntry[];
  decisions: IKnowledgeEntry[];
  conventions: IKnowledgeEntry[];
  technical: IKnowledgeEntry[];
  warnings: IKnowledgeEntry[];
  commands: IKnowledgeEntry[];
  workflows: IKnowledgeEntry[];
  testing: IKnowledgeEntry[];
  security: IKnowledgeEntry[];
  /**
   * Genuinely-misc high-signal types that don't map to a dedicated section
   * (feature / business / environment / dependency / deployment / integration /
   * custom / …). Surfaced by default in the "Project Knowledge" section — these
   * used to be dropped entirely unless `--include-docs` was set.
   */
  knowledge: IKnowledgeEntry[];
  docs: IKnowledgeEntry[];
  tasks: IKnowledgeEntry[];
}

const TYPE_BUCKETS: Record<string, keyof SelectedEntries> = {
  rule: 'rules',
  path: 'paths',
  template: 'templates',
  architecture: 'architecture',
  decision: 'decisions',
  convention: 'conventions',
  technical: 'technical',
  warning: 'warnings',
  command: 'commands',
  workflow: 'workflows',
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

  // Pack search-tuning boost: stable-sort so boosted entries (delta > 0) bubble
  // ahead of unboosted ones (delta = 0) while preserving the relevance order
  // among equal boosts. Lets a boosted rule/knowledge entry cross the
  // per-section cap, mirroring how the task ranker applies the same tuning.
  const boostFor = request.boostFor;
  const ranked = boostFor
    ? [...searchAll].sort((a, b) => {
        const sa = a.score + (boostFor(a.entry) ?? 0);
        const sb = b.score + (boostFor(b.entry) ?? 0);
        return sb - sa || a.entry.id.localeCompare(b.entry.id);
      })
    : searchAll;

  const buckets: SelectedEntries = {
    rules: [],
    paths: [],
    templates: [],
    architecture: [],
    decisions: [],
    conventions: [],
    technical: [],
    warnings: [],
    commands: [],
    workflows: [],
    testing: [],
    security: [],
    knowledge: [],
    docs: [],
    tasks: [],
  };

  for (const r of ranked) {
    const typeKey = String(r.entry.type).toLowerCase();
    const bucketKey = TYPE_BUCKETS[typeKey];
    if (bucketKey) {
      if (buckets[bucketKey].length < limitPerSection) buckets[bucketKey].push(r.entry);
      continue;
    }
    // Unmapped type. Route to the default "Project Knowledge" bucket so a
    // high-signal entry (e.g. a Decision/Feature whose appliesWhen matches the
    // task) reaches the agent by default. `--include-docs` only ADDS the
    // lowest-value overflow into "Reference Docs" — it no longer gates ALL
    // unmapped types behind an off-by-default flag.
    if (buckets.knowledge.length < limitPerSection) {
      buckets.knowledge.push(r.entry);
    } else if (request.includeDocs && buckets.docs.length < limitPerSection) {
      buckets.docs.push(r.entry);
    }
  }

  return buckets;
}
