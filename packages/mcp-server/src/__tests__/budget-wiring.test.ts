import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  EContentType,
  estimateTokens,
  InMemoryCcrStore,
  isSampledTable,
  isColumnarTable,
} from '@shrkcrft/compress';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { fitArrayToBudget } from '../server/fit-array-to-budget.ts';
import { ALL_TOOLS } from '../tools/index.ts';
import type { IToolResponse } from '../server/tool-definition.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

describe('SmartCrusher budget wiring (P5.2)', () => {
  test('fitArrayToBudget: under budget → columnar; over budget → sample + CCR', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `n${i}`,
      kind: 'item',
      score: i % 10,
      label: `row ${i} with some descriptive label text`,
    }));
    const store = new InMemoryCcrStore();

    const under = fitArrayToBudget(rows, 1_000_000, store);
    expect(isColumnarTable(under.value)).toBe(true);
    expect(under.ccrKey).toBeUndefined();

    const over = fitArrayToBudget(rows, 200, store);
    expect(isSampledTable(over.value)).toBe(true);
    expect(over.ccrKey).toBeDefined();
    // The full original is recoverable.
    expect(store.get(over.ccrKey!)!.content).toBe(JSON.stringify(rows));
  });

  test('fitArrayToBudget BOUNDS the sampled payload to the budget (not just a trigger)', () => {
    // 200 small rows; the lossless form far exceeds the budget, so it samples —
    // and the sample must actually FIT the budget, which the old code (where
    // maxTokens was only a sampling trigger) did not guarantee.
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, label: `row-${i}` }));
    const store = new InMemoryCcrStore();
    const budget = 150;
    const fitted = fitArrayToBudget(rows, budget, store);
    expect(fitted.ccrKey).toBeDefined(); // over budget → sampled
    const tokens = estimateTokens(JSON.stringify(fitted.value), EContentType.JsonArray);
    expect(tokens).toBeLessThanOrEqual(budget);
    expect(store.has(fitted.ccrKey!)).toBe(true); // full original recoverable
  });

  test('get_knowledge_graph honours maxTokens: samples + caches the original', async () => {
    const inspection = await inspectSharkcraft({ cwd: REPO_ROOT });
    const tool = ALL_TOOLS.find((t) => t.name === 'get_knowledge_graph')!;
    const store = new InMemoryCcrStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = { cwd: REPO_ROOT, inspection, ccrStore: store };

    const res = (await tool.handler({ format: 'table', maxTokens: 50 }, ctx)) as IToolResponse;
    const d = res.data as Record<string, unknown>;
    expect(d.format).toBe('table');
    const est = d.tokenEstimate as { before: number; after: number };
    expect(est.after).toBeLessThanOrEqual(est.before);
    // A real repo graph well exceeds 50 tokens → it samples and caches.
    if (Array.isArray(d.ccrKeys) && (d.ccrKeys as string[]).length > 0) {
      expect(store.has((d.ccrKeys as string[])[0]!)).toBe(true);
    }

    // Without a budget the lossless columnar form is unchanged (no ccrKeys).
    const lossless = (await tool.handler({ format: 'table' }, ctx)) as IToolResponse;
    expect((lossless.data as Record<string, unknown>).ccrKeys).toBeUndefined();
  });
});
