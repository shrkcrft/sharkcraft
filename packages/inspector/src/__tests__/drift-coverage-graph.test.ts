import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  buildCoverageReport,
  buildDriftReport,
  buildKnowledgeGraph,
  inspectSharkcraft,
} from '../index.ts';

const DOGFOOD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('drift / coverage / graph (dogfood)', () => {
  test('drift report runs and returns category counts', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const r = buildDriftReport(inspection, { runBoundaries: true });
    expect(typeof r.counts.error).toBe('number');
    expect(typeof r.counts.warning).toBe('number');
    expect(typeof r.counts.info).toBe('number');
  });

  test('coverage report covers all categories', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const r = buildCoverageReport(inspection);
    expect(r.categories.length).toBeGreaterThanOrEqual(6);
    expect(typeof r.overall).toBe('number');
  });

  test('knowledge graph has nodes for templates and pipelines', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const g = buildKnowledgeGraph(inspection);
    expect(g.nodes.some((n) => n.kind === 'template')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'pipeline')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'preset')).toBe(true);
  });
});
