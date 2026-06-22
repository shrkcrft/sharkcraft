import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  test('an under-grounded repo does not score 100 (empty categories excluded)', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-cov-empty-'));
    try {
      writeFileSync(nodePath.join(root, 'package.json'), JSON.stringify({ name: 'empty', version: '1.0.0' }));
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = buildCoverageReport(inspection);
      // A repo with no authored rules/templates/pipelines/boundaries must not
      // read as perfectly covered — empty categories vacuously score 100 and
      // used to inflate the overall to 100/100.
      expect(r.overall).toBeLessThan(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('knowledge graph has nodes for templates and pipelines', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD });
    const g = buildKnowledgeGraph(inspection);
    expect(g.nodes.some((n) => n.kind === 'template')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'pipeline')).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'preset')).toBe(true);
  });
});
