import { describe, expect, test } from 'bun:test';
import { runComprehensionEval } from '../compress-comprehension-eval.ts';

describe('compress-comprehension-eval harness (P4.1)', () => {
  test(
    'produces a per-format wire-token table and degrades gracefully without a model',
    async () => {
      const r = await runComprehensionEval();
      expect(r.rows.length).toBe(4);

      const bare = r.rows.find((x) => x.format === 'bare-array')!;
      const columnar = r.rows.find((x) => x.format === 'columnar')!;
      expect(bare.wireTokens).toBeGreaterThan(0);
      // The whole point: columnar (and the flat formats) save wire tokens vs bare.
      expect(columnar.wireSavedVsBare).toBeGreaterThan(0);

      // Accuracy is either n/a (no local model) or a valid ratio — never a crash.
      for (const row of r.rows) {
        expect(row.accuracy === null || (row.accuracy >= 0 && row.accuracy <= 1)).toBe(true);
      }
    },
    120000,
  );
});
