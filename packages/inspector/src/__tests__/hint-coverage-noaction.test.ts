import { describe, expect, test } from 'bun:test';
import { defineKnowledgeEntry, KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { buildCoverageReport } from '../coverage-report.ts';

const entries = [
  // Excluded via the PER-ENTRY lever (noAction) — a context-only overview.
  defineKnowledgeEntry({
    id: 'arch.overview',
    title: 'Architecture overview',
    type: KnowledgeType.Architecture,
    priority: KnowledgePriority.Critical,
    content: 'The system has three layers.',
    noAction: true,
  }),
  // Excluded via the TYPE FLOOR (business — no actionable next step).
  defineKnowledgeEntry({
    id: 'biz.context',
    title: 'Business context',
    type: KnowledgeType.Business,
    priority: KnowledgePriority.Critical,
    content: 'We bill monthly.',
  }),
  // Actionable but WITHOUT a meaningful hint → counted, not covered.
  defineKnowledgeEntry({
    id: 'r.nohint',
    title: 'Rule without a hint',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Critical,
    content: 'Do the thing.',
  }),
  // Actionable WITH a meaningful hint → counted + covered.
  defineKnowledgeEntry({
    id: 'r.withhint',
    title: 'Rule with a real hint',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    content: 'Run the check.',
    actionHints: { commands: [{ command: 'shrk check boundaries' }] },
  }),
];

const inspection = {
  projectRoot: '/tmp/proj',
  knowledgeEntries: entries,
  templates: [],
  pipelines: [],
  ruleService: { list: () => [] },
  pathService: { list: () => [] },
  presetRegistry: { list: () => [] },
  boundaryRegistry: { list: () => [] },
  packs: { discoveredPacks: [] },
} as unknown as ISharkcraftInspection;

describe('hint-coverage — quality-scored, with no-action exemptions', () => {
  test('denominator excludes noAction + descriptive-type entries; scores meaningfulness', () => {
    const report = buildCoverageReport(inspection);
    const hint = report.categories.find((c) => c.id === 'hint-coverage')!;
    // Only the two actionable Rule entries are in the denominator — arch.overview
    // (noAction) and biz.context (type floor) are exempt.
    expect(hint.total).toBe(2);
    // Only r.withhint has a MEANINGFUL hint; r.nohint is counted-but-uncovered.
    expect(hint.covered).toBe(1);
    expect(hint.score).toBe(50);
    expect(hint.missing.some((m) => m.includes('r.nohint'))).toBe(true);
    expect(hint.missing.some((m) => m.includes('arch.overview'))).toBe(false);
  });
});
