import { describe, expect, test } from 'bun:test';
import {
  compressContent,
  compactObjectArray,
  tableToColumnar,
  expandColumnar,
  alignVolatileTokens,
  restoreVolatileTokens,
  ccrKey,
  InMemoryCcrStore,
} from '../index.ts';

/** Deterministic PRNG (mulberry32) so any failure reproduces exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UUIDS = [
  '550e8400-e29b-41d4-a716-446655440000',
  '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  '11111111-2222-3333-4444-555555555555',
];

describe('property: columnar compaction is lossless', () => {
  test('expandColumnar ∘ compactObjectArray round-trips 300 random homogeneous arrays', () => {
    const r = rng(1234);
    const keys = ['id', 'kind', 'title', 'score', 'note'];
    let checked = 0;
    for (let iter = 0; iter < 300; iter += 1) {
      const n = 2 + Math.floor(r() * 18);
      const arr = Array.from({ length: n }, (_, i) => {
        const row: Record<string, unknown> = {};
        for (const k of keys) {
          if (r() < 0.75) {
            const kind = r();
            row[k] =
              kind < 0.3 ? `${k}-${i}` : kind < 0.55 ? Math.floor(r() * 1000) : kind < 0.7 ? null : kind < 0.85 ? r() < 0.5 : { nested: i, tag: `${k}` };
          }
        }
        return row;
      });
      const compaction = compactObjectArray(arr);
      if (!compaction) continue; // too heterogeneous to compact — not applicable
      checked += 1;
      const restored = expandColumnar(tableToColumnar(compaction));
      expect(restored).toEqual(JSON.parse(JSON.stringify(arr)));
    }
    expect(checked).toBeGreaterThan(50); // ensure we actually exercised the path
  });
});

describe('property: cache alignment is reversible', () => {
  test('restore ∘ align is the identity for 200 random texts with volatile tokens', () => {
    const r = rng(99);
    const words = ['build', 'run', 'the', 'value', 'config', 'at', 'and', 'done', 'retry'];
    for (let iter = 0; iter < 200; iter += 1) {
      const parts: string[] = [];
      const len = 3 + Math.floor(r() * 20);
      for (let i = 0; i < len; i += 1) {
        const pick = r();
        if (pick < 0.25) parts.push(UUIDS[Math.floor(r() * UUIDS.length)]!);
        else if (pick < 0.32) parts.push('2026-06-15T10:00:00Z');
        else if (pick < 0.38) parts.push('d41d8cd98f00b204e9800998ecf8427e');
        else parts.push(words[Math.floor(r() * words.length)]!);
      }
      const text = parts.join(' ');
      const aligned = alignVolatileTokens(text);
      expect(restoreVolatileTokens(aligned.aligned, aligned.map)).toBe(text);
    }
  });
});

describe('property: CCR is exact and deterministic', () => {
  test('ccrKey is stable and the store round-trips content byte-for-byte', () => {
    const r = rng(7);
    const store = new InMemoryCcrStore(2048);
    for (let iter = 0; iter < 200; iter += 1) {
      const content = Array.from({ length: 1 + Math.floor(r() * 40) }, () =>
        String.fromCharCode(32 + Math.floor(r() * 94)),
      ).join('');
      expect(ccrKey(content)).toBe(ccrKey(content));
      const key = store.put(content);
      expect(store.get(key)!.content).toBe(content);
    }
  });
});

describe('property: compressContent is deterministic and never a net loss', () => {
  test('200 varied blobs: same output twice, and after <= before', () => {
    const r = rng(2024);
    const makeBlob = (): string => {
      const kind = Math.floor(r() * 4);
      if (kind === 0) {
        const arr = Array.from({ length: 2 + Math.floor(r() * 30) }, (_, i) => ({
          id: `n${i}`,
          k: 'x',
          t: `title ${i}`,
        }));
        return JSON.stringify(arr);
      }
      if (kind === 1) {
        return Array.from({ length: 5 + Math.floor(r() * 30) }, (_, i) =>
          r() < 0.2 ? `ERROR failure ${i}` : `INFO step ${i} routine work`,
        ).join('\n');
      }
      if (kind === 2) {
        return Array.from({ length: 5 + Math.floor(r() * 30) }, (_, i) => `word${i} the quick brown fox`).join('\n');
      }
      return Array.from({ length: 5 + Math.floor(r() * 20) }, (_, i) => `src/f${i}.ts:${i}:const x = ${i}`).join('\n');
    };
    for (let iter = 0; iter < 200; iter += 1) {
      const blob = makeBlob();
      const a = compressContent(blob);
      const b = compressContent(blob);
      expect(a.compressed).toBe(b.compressed); // deterministic
      expect(a.savings.after).toBeLessThanOrEqual(a.savings.before); // never a net loss
    }
  });
});
