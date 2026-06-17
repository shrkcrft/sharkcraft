import { describe, expect, test } from 'bun:test';
import {
  compactObjectMap,
  expandObjectMap,
  isObjectMap,
  compressJson,
  ECompressionStrategy,
} from '../index.ts';

/** Deterministic LCG for reproducible property fuzz. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('object-map columnar (P2.3)', () => {
  test('a 50-key homogeneous map round-trips losslessly and shrinks', () => {
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      map[`node-${i}`] = { kind: i % 2 === 0 ? 'file' : 'symbol', score: i / 50, label: `n${i}` };
    }
    const compact = compactObjectMap(map);
    expect(compact).not.toBeNull();
    expect(expandObjectMap(compact!)).toEqual(map);

    const r = compressJson(JSON.stringify(map));
    expect(r.strategy).toBe(ECompressionStrategy.Table);
    expect(r.note).toContain('object-map');
    expect(r.savings.saved).toBeGreaterThan(0);

    // The wire form is a valid `_omap` envelope that reconstructs the original.
    const parsed = JSON.parse(r.compressed);
    expect(isObjectMap(parsed)).toBe(true);
    expect(expandObjectMap(parsed)).toEqual(map);
  });

  test('null vs absent keys are preserved distinctly', () => {
    const map = {
      a: { x: null, y: 1, z: 'keep' },
      b: { y: 2, z: 'keep' },
      c: { x: 3, y: 4, z: 'keep' },
    };
    const compact = compactObjectMap(map);
    expect(compact).not.toBeNull();
    const back = expandObjectMap(compact!) as typeof map;
    expect(back).toEqual(map);
    // `a.x` is a genuine null (present); `b.x` is absent (key not set).
    expect('x' in back.a).toBe(true);
    expect(back.a.x).toBeNull();
    expect('x' in back.b).toBe(false);
  });

  test('heterogeneous maps fall through unchanged', () => {
    // Values aren't all objects.
    expect(compactObjectMap({ a: 1, b: 2, c: 3 })).toBeNull();
    // Too few entries.
    expect(compactObjectMap({ only: { a: 1 } })).toBeNull();
    // Mixed object/non-object values.
    expect(compactObjectMap({ a: { x: 1 }, b: 'nope' })).toBeNull();

    const mixed = JSON.stringify({ a: 1, b: 'two', c: [1, 2, 3] });
    const r = compressJson(mixed);
    expect(r.note).not.toContain('object-map');
    expect(isObjectMap(JSON.parse(r.compressed))).toBe(false);

    // A non-map value cannot be expanded.
    expect(expandObjectMap({ not: 'a map' })).toBeNull();
    expect(expandObjectMap([1, 2, 3])).toBeNull();
  });

  test('heterogeneous-schema maps below the core ratio do not compact', () => {
    // Every entry has a unique key → no shared columns → not worth hoisting.
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) map[`k${i}`] = { [`uniq${i}`]: i };
    expect(compactObjectMap(map)).toBeNull();
  });

  test('compaction is deterministic', () => {
    const map: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) map[`e${i}`] = { b: i, a: `v${i}`, c: i % 2 === 0 };
    expect(JSON.stringify(compactObjectMap(map))).toBe(JSON.stringify(compactObjectMap(map)));
  });

  test('property fuzz: expand ∘ compact === id for every map that compacts', () => {
    for (const seed of [3, 11, 99, 2024, 55555]) {
      const rng = makeRng(seed);
      const map: Record<string, unknown> = {};
      const n = 2 + Math.floor(rng() * 40);
      for (let i = 0; i < n; i += 1) {
        const entry: Record<string, unknown> = {};
        // Shared core columns present most of the time + occasional extras.
        if (rng() > 0.05) entry.id = `x${i}`;
        if (rng() > 0.1) entry.score = Math.round(rng() * 1000) / 100;
        if (rng() > 0.15) entry.flag = rng() > 0.5;
        if (rng() > 0.5) entry.maybe = rng() > 0.5 ? null : `m${i}`;
        if (rng() > 0.9) entry[`rare${i}`] = i;
        map[`key-${i}`] = entry;
      }
      const compact = compactObjectMap(map);
      if (compact) expect(expandObjectMap(compact)).toEqual(map);
    }
  });
});
