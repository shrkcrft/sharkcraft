import { describe, expect, test } from 'bun:test';
import {
  computeOptimalK,
  simhash,
  hammingDistance,
  kneedle,
  bigramCoverageCurve,
  sampleObjectArray,
} from '../index.ts';

describe('adaptive sizing (P3.1)', () => {
  test('keeps materially fewer rows on a redundant corpus than a diverse one', () => {
    const redundant = Array.from({ length: 100 }, () => 'processing the next item now ok');
    // Every token unique across all lines → genuinely diverse (no shared words).
    const diverse = Array.from({ length: 100 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => `t${i}x${j}q${i * 6 + j}`).join(' '),
    );
    const kRedundant = computeOptimalK(redundant);
    const kDiverse = computeOptimalK(diverse);
    expect(kRedundant).toBeLessThan(kDiverse);
    // Truly identical content collapses hard; diverse content keeps most.
    expect(kRedundant).toBeLessThanOrEqual(10);
    expect(kDiverse).toBeGreaterThan(50);
  });

  test('a templated counter log is recognized as redundant (zlib bound)', () => {
    const templated = Array.from({ length: 100 }, (_, i) => `worker ${i} processed batch ${i} ok`);
    expect(computeOptimalK(templated)).toBeLessThan(60);
  });

  test('never exceeds the explicit max, respects min, and is deterministic', () => {
    const items = Array.from({ length: 80 }, (_, i) => `item number ${i} here`);
    expect(computeOptimalK(items, { max: 5 })).toBeLessThanOrEqual(5);
    expect(computeOptimalK(items, { min: 20, max: 200 })).toBeGreaterThanOrEqual(20);
    expect(computeOptimalK(items)).toBe(computeOptimalK(items));
    // n <= min → keep all.
    expect(computeOptimalK(['a', 'b'], { min: 5 })).toBe(2);
  });

  test('bias shifts the knee: conservative ≥ moderate ≥ aggressive', () => {
    const items = Array.from({ length: 60 }, (_, i) => `event ${i % 7} of kind ${i % 3} seen`);
    const cons = computeOptimalK(items, { bias: 'conservative' });
    const mod = computeOptimalK(items, { bias: 'moderate' });
    const agg = computeOptimalK(items, { bias: 'aggressive' });
    expect(cons).toBeGreaterThanOrEqual(mod);
    expect(mod).toBeGreaterThanOrEqual(agg);
  });

  test('helpers behave: simhash near-dups, hamming, kneedle, coverage', () => {
    // Near-identical strings → small Hamming distance; unrelated → larger.
    const a = simhash('the quick brown fox jumps');
    const b = simhash('the quick brown fox leaps');
    const c = simhash('completely unrelated content here now');
    expect(hammingDistance(a, b)).toBeLessThan(hammingDistance(a, c));
    expect(hammingDistance(a, a)).toBe(0);

    // A saturating curve has a clear knee; a straight line does not.
    const saturating = [0, 5, 8, 9, 10, 10, 10, 10];
    const linear = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(kneedle(saturating).deflection).toBeGreaterThan(kneedle(linear).deflection);

    // Coverage is monotone nondecreasing.
    const curve = bigramCoverageCurve(['a b c', 'a b c', 'x y z']);
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
  });

  test('sampler: adaptive default keeps the outlier; explicit maxItems still wins', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `n${i}`,
      kind: 'item',
      score: i === 250 ? 99999 : i % 10,
    }));
    // Adaptive default (no maxItems): the numeric outlier survives.
    const adaptive = sampleObjectArray(rows)!;
    expect(adaptive._table.sample.dropped).toBeGreaterThan(0);
    expect(JSON.stringify(adaptive._table.rows).includes('99999')).toBe(true);

    // Explicit cap overrides adaptive sizing.
    const capped = sampleObjectArray(rows, { maxItems: 12 })!;
    expect(capped._table.sample.kept).toBeLessThanOrEqual(12);
  });
});
