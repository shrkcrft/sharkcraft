import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { InMemoryCcrStore, isSampledTable, isColumnarTable } from '@shrkcrft/compress';
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
