import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgeIndex,
  KnowledgePriority,
  KnowledgeType,
} from '@shrkcrft/knowledge';
import { selectRelevantEntries } from '../relevance-selector.ts';

const base = {
  scope: ['demo'] as const,
  priority: KnowledgePriority.High,
  appliesWhen: ['generate-code'] as const,
  content: 'body',
};

const entries = [
  defineKnowledgeEntry({ ...base, id: 'decision.db', title: 'Use Postgres', type: KnowledgeType.Decision }),
  defineKnowledgeEntry({ ...base, id: 'convention.naming', title: 'kebab files', type: KnowledgeType.Convention }),
  defineKnowledgeEntry({ ...base, id: 'workflow.release', title: 'Release flow', type: KnowledgeType.Workflow }),
  defineKnowledgeEntry({ ...base, id: 'feature.search', title: 'Search feature', type: KnowledgeType.Feature }),
];

describe('selectRelevantEntries — orphan knowledge types', () => {
  test('decision / convention / workflow land in dedicated buckets, not docs (includeDocs:false)', () => {
    const sel = selectRelevantEntries(entries, { task: 'add a feature', scope: ['demo'] });
    expect(sel.decisions.map((e) => e.id)).toContain('decision.db');
    expect(sel.conventions.map((e) => e.id)).toContain('convention.naming');
    expect(sel.workflows.map((e) => e.id)).toContain('workflow.release');
    // Default-off docs bucket stays empty — these used to be dropped there.
    expect(sel.docs).toEqual([]);
  });

  test('a genuinely-misc type still surfaces in the default Project Knowledge bucket', () => {
    const sel = selectRelevantEntries(entries, { task: 'add a feature', scope: ['demo'] });
    expect(sel.knowledge.map((e) => e.id)).toContain('feature.search');
    // It is NOT silently routed to the off-by-default docs bucket.
    expect(sel.docs.map((e) => e.id)).not.toContain('feature.search');
  });
});

describe('KnowledgeIndex — deterministic tie-break', () => {
  test('equal-score entries sort by id regardless of insertion order', () => {
    // Inserted in DESCENDING id order; both match scope `tie` with identical
    // score (priority baseline + scope bonus), so only the id tie-break decides.
    const index = new KnowledgeIndex([
      defineKnowledgeEntry({
        id: 'zeta.one',
        title: 'Z',
        type: KnowledgeType.Technical,
        priority: KnowledgePriority.Medium,
        scope: ['tie'],
        content: 'x',
      }),
      defineKnowledgeEntry({
        id: 'alpha.one',
        title: 'A',
        type: KnowledgeType.Technical,
        priority: KnowledgePriority.Medium,
        scope: ['tie'],
        content: 'x',
      }),
    ]);
    const results = index.search({ scope: ['tie'] });
    expect(results.map((r) => r.entry.id)).toEqual(['alpha.one', 'zeta.one']);
  });
});
