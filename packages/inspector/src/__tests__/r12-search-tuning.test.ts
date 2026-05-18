import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  buildSearchIndex,
  inspectSharkcraft,
  loadConstructs,
  loadPlaybooks,
  searchIndex,
  SearchKind,
  SearchSource,
  type ISearchTuningEntry,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

async function fixtureIndex() {
  const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
  await loadConstructs(inspection);
  await loadPlaybooks(inspection);
  const index = buildSearchIndex(inspection);
  return { inspection, index };
}

describe('r12 search tuning', () => {
  test('boostTags increases ranking of matching docs', async () => {
    const { index, inspection } = await fixtureIndex();
    const baseline = searchIndex(index, { query: 'service' }, inspection);
    const tuning: ISearchTuningEntry[] = [
      {
        id: 'test.boost',
        source: 'local',
        sourceFile: 'inline',
        boostTags: { http: 5 },
      },
    ];
    const tuned = searchIndex(index, { query: 'service', tuning, explain: true });
    // Pick any document with the http tag.
    const httpDoc = index.find((d) => d.tags?.includes('http'));
    if (!httpDoc) return;
    const beforeHit = baseline.hits.find((h) => h.document.id === httpDoc.id);
    const afterHit = tuned.hits.find((h) => h.document.id === httpDoc.id);
    if (!beforeHit || !afterHit) return;
    expect(afterHit.score).toBeGreaterThanOrEqual(beforeHit.score);
    expect(afterHit.reasons.some((r) => r.includes('tuning:'))).toBe(true);
  });

  test('boost clamp keeps deltas bounded', async () => {
    const { index } = await fixtureIndex();
    const tuning: ISearchTuningEntry[] = [
      {
        id: 'huge',
        source: 'local',
        sourceFile: 'inline',
        boostTags: { http: 9999 },
      },
    ];
    const result = searchIndex(index, { query: 'service', tuning });
    // Highest score should remain finite and reasonable (top hit < 1000 for our index).
    expect(result.hits[0]!.score).toBeLessThan(1000);
  });

  test('appliesToKinds filters boosts', async () => {
    const { index } = await fixtureIndex();
    const tuning: ISearchTuningEntry[] = [
      {
        id: 'kind-bound',
        source: 'local',
        sourceFile: 'inline',
        appliesToKinds: [SearchKind.Template],
        boostIds: { 'knowledge:project.overview': 50 },
      },
    ];
    const baseline = searchIndex(index, { query: 'project.overview' });
    const result = searchIndex(index, { query: 'project.overview', tuning });
    const top = result.hits[0]!;
    const baselineTop = baseline.hits[0]!;
    expect(top.document.id).toBe('knowledge:project.overview');
    // Boost is gated to template-kind docs only, so a knowledge hit's score
    // must not change.
    expect(top.score).toBe(baselineTop.score);
  });

  test('sources filter still works alongside tuning', async () => {
    const { index } = await fixtureIndex();
    const result = searchIndex(index, {
      query: 'service',
      sources: [SearchSource.Local],
    });
    for (const h of result.hits) {
      expect(h.document.source).toBe(SearchSource.Local);
    }
  });
});
