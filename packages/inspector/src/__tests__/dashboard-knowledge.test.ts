import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
} from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import {
  buildDashboardKnowledgeList,
  buildDashboardKnowledgeGraph,
  buildDashboardKnowledgeSimilar,
} from '../dashboard/dashboard-knowledge.ts';

const entries = [
  defineKnowledgeEntry({
    id: 'r.safety',
    title: 'Safety rule',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    scope: ['safety'],
    tags: ['safety', 'mcp'],
    appliesWhen: ['review-code'],
    content: 'MCP is read-only.',
    summary: 'No writes through MCP.',
    related: ['r.gen'],
    actionHints: {
      commands: [{ command: 'shrk doctor' }],
      forbiddenActions: ['Writing through MCP.'],
      relatedKnowledge: ['r.gen'],
    },
  }),
  defineKnowledgeEntry({
    id: 'r.gen',
    title: 'Generation rule',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['safety', 'generation'],
    tags: ['generator'],
    content: 'Dry-run by default.',
  }),
  defineKnowledgeEntry({
    id: 'tech.stack',
    title: 'Tech stack',
    type: KnowledgeType.Technical,
    priority: KnowledgePriority.Low,
    scope: ['build'],
    tags: ['bun'],
    content: 'Bun + TypeScript.',
  }),
];

// list / graph builders read only knowledgeEntries + projectRoot.
const inspection = {
  projectRoot: '/tmp/proj',
  knowledgeEntries: entries,
} as unknown as ISharkcraftInspection;

describe('buildDashboardKnowledgeList', () => {
  test('summarizes every entry, highest priority first', () => {
    const r = buildDashboardKnowledgeList(inspection);
    expect(r.available).toBe(true);
    expect(r.total).toBe(3);
    expect(r.entries.map((e) => e.id)).toEqual(['r.safety', 'r.gen', 'tech.stack']);
    const safety = r.entries[0]!;
    expect(safety.hasActionHints).toBe(true);
    expect(safety.relatedCount).toBe(1);
    expect(safety.summary).toBe('No writes through MCP.');
  });

  test('builds type/scope/tag facets with counts', () => {
    const r = buildDashboardKnowledgeList(inspection);
    expect(r.facets.types.find((f) => f.value === 'rule')?.count).toBe(2);
    expect(r.facets.scopes.find((f) => f.value === 'safety')?.count).toBe(2);
    expect(r.facets.tags.find((f) => f.value === 'safety')?.count).toBe(1);
  });

  test('empty workspace → available false', () => {
    const empty = { projectRoot: '/tmp', knowledgeEntries: [] } as unknown as ISharkcraftInspection;
    expect(buildDashboardKnowledgeList(empty).available).toBe(false);
  });

  test('computes priority distribution + quality insights', () => {
    const r = buildDashboardKnowledgeList(inspection);
    expect(r.insights.byPriority).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    // r.gen + tech.stack have no action hints; r.safety does.
    expect(r.insights.withoutActionHints).toBe(2);
    // only r.safety has a summary.
    expect(r.insights.withoutSummary).toBe(2);
    // r.gen + tech.stack have no related links.
    expect(r.insights.orphans).toBe(2);
    expect(r.facets.priorities.find((f) => f.value === 'critical')?.count).toBe(1);
  });
});

describe('buildDashboardKnowledgeSimilar', () => {
  test('ranks other entries by relevance and excludes the entry itself', () => {
    const r = buildDashboardKnowledgeSimilar(inspection, 'r.safety');
    expect(r.id).toBe('r.safety');
    expect(r.available).toBe(true);
    expect(r.similar.some((s) => s.id === 'r.safety')).toBe(false);
    // r.gen shares the 'safety' scope, so it should surface.
    expect(r.similar.some((s) => s.id === 'r.gen')).toBe(true);
  });

  test('unknown id → not available', () => {
    const r = buildDashboardKnowledgeSimilar(inspection, 'nope');
    expect(r.available).toBe(false);
    expect(r.similar).toEqual([]);
  });
});

describe('buildDashboardKnowledgeGraph', () => {
  test('emits a node per entry and related + scope edges', () => {
    const g = buildDashboardKnowledgeGraph(inspection);
    expect(g.available).toBe(true);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['r.gen', 'r.safety', 'tech.stack']);
    // rule type → 'rule' kind colour bucket.
    expect(g.nodes.find((n) => n.id === 'r.safety')?.kind).toBe('rule');
    // related edge r.safety↔r.gen (from related + relatedKnowledge, deduped).
    const related = g.edges.filter((e) => e.kind === 'related');
    expect(related.some((e) => (e.from === 'r.safety' && e.to === 'r.gen') || (e.from === 'r.gen' && e.to === 'r.safety'))).toBe(true);
    // scope cluster: r.safety and r.gen share 'safety'.
    expect(g.edges.some((e) => e.kind === 'scope')).toBe(true);
    expect(g.truncated).toBe(false);
  });

  test('does not link to entries outside the set', () => {
    const g = buildDashboardKnowledgeGraph(inspection);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});
