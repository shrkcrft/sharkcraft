import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  buildSearchIndex,
  inspectSharkcraft,
  loadConstructs,
  loadPlaybooks,
  searchIndex,
  SearchKind,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r11 unified search index', () => {
  test('exact id match scores highest', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    await loadConstructs(inspection);
    await loadPlaybooks(inspection);
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: 'project.overview' });
    expect(result.hits.length).toBeGreaterThan(0);
    const top = result.hits[0]!;
    expect(top.document.id).toBe('knowledge:project.overview');
  });

  test('grouped output by kind', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: 'service' });
    expect(result.grouped.size).toBeGreaterThan(0);
    expect(result.grouped.has(SearchKind.Knowledge)).toBe(true);
  });

  test('explain surfaces reasons', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: 'project.overview', explain: true });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.reasons.length).toBeGreaterThan(0);
  });

  test('limit truncates results', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: 'service', limit: 2 });
    expect(result.hits.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  test('kinds filter excludes unwanted kinds', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const index = buildSearchIndex(inspection);
    const result = searchIndex(index, { query: 'service', kinds: [SearchKind.Template] });
    for (const h of result.hits) {
      expect(h.document.kind).toBe(SearchKind.Template);
    }
  });
});
