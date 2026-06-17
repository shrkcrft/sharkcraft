import { describe, expect, test } from 'bun:test';
import { mineLogTemplates, reconstructLogTemplates } from '../text/log-template.ts';
import {
  compressLog,
  estimateTokens,
  EContentType,
  ECompressionStrategy,
  InMemoryCcrStore,
  parseCcrMarkers,
} from '../index.ts';

function roundTrips(lines: string[]): boolean {
  const mined = mineLogTemplates(lines);
  return reconstructLogTemplates(mined.lines.join('\n')) === lines.join('\n');
}

/** Deterministic LCG so the fuzz corpus is reproducible run-to-run. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe('log-template mining (P2.2)', () => {
  test('collapses 200 worker/batch lines to one block, reconstructs exactly, ≥70% fewer tokens', () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `worker-${i % 4} processing batch ${i} ok`,
    );
    const mined = mineLogTemplates(lines);

    expect(mined.reduced).toBe(true);
    // 200 lines → one tiny block (header + 2 column encodings + close).
    expect(mined.lines.length).toBeLessThanOrEqual(8);
    // Exact, order-preserving reconstruction (lossless).
    expect(reconstructLogTemplates(mined.lines.join('\n'))).toBe(lines.join('\n'));

    const before = estimateTokens(lines.join('\n'), EContentType.BuildLog);
    const after = estimateTokens(mined.lines.join('\n'), EContentType.BuildLog);
    expect(1 - after / before).toBeGreaterThanOrEqual(0.7);
  });

  test('non-repetitive logs pass through unchanged', () => {
    const lines = [
      'starting build pipeline',
      'resolving dependency graph',
      'type-checking workspace',
      'bundling output',
      'writing artifacts to dist',
      'pipeline complete',
    ];
    const mined = mineLogTemplates(lines);
    expect(mined.reduced).toBe(false);
    expect(mined.lines).toEqual(lines);
  });

  test('a mixed template/error log keeps the error line and preserves order', () => {
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => `req ${i} served in ${i * 2}ms`),
      'ERROR upstream timeout talking to db-1',
      ...Array.from({ length: 10 }, (_, i) => `req ${i + 10} served in ${i * 2}ms`),
    ];
    const mined = mineLogTemplates(lines);
    // The error is never folded into a template — it stays verbatim, in place.
    expect(mined.lines).toContain('ERROR upstream timeout talking to db-1');
    expect(reconstructLogTemplates(mined.lines.join('\n'))).toBe(lines.join('\n'));
  });

  test('column encodings round-trip: seq, cyc, lit, escaping, leading zeros', () => {
    // seq (batch counter) + cyc (worker) + lit-with-pipe (quoted) + leading-zero id.
    const lines = Array.from(
      { length: 12 },
      (_, i) => `id ${String(i).padStart(3, '0')} worker-${i % 3} said "a|b ${i}" code 0x${i.toString(16)}`,
    );
    expect(roundTrips(lines)).toBe(true);
  });

  test('a block sentinel in the input disables mining (no collision)', () => {
    const lines = [...Array.from({ length: 6 }, (_, i) => `tick ${i}`), '⟦ literal bracket ⟧'];
    const mined = mineLogTemplates(lines);
    expect(mined.reduced).toBe(false);
    expect(mined.lines).toEqual(lines);
  });

  test('fuzz: every mined corpus reconstructs exactly (multiple seeds)', () => {
    const words = ['worker', 'batch', 'task', 'shard', 'ok', 'done', 'retry', 'flush', 'commit'];
    for (const seed of [1, 7, 42, 1337, 90210]) {
      const rng = makeRng(seed);
      const lines: string[] = [];
      const runs = 6 + Math.floor(rng() * 6);
      for (let r = 0; r < runs; r += 1) {
        const w1 = words[Math.floor(rng() * words.length)]!;
        const w2 = words[Math.floor(rng() * words.length)]!;
        const len = 1 + Math.floor(rng() * 8);
        const style = Math.floor(rng() * 4);
        for (let k = 0; k < len; k += 1) {
          let val: string;
          if (style === 0) val = String(k); // seq
          else if (style === 1) val = String(k % 3); // cyc
          else if (style === 2) val = `"v|${Math.floor(rng() * 1000)}"`; // lit w/ pipe
          else val = `0x${(k * 7).toString(16)}`; // hex
          lines.push(`${w1} ${val} ${w2} ${(k * 3) % 100}`);
        }
        if (rng() < 0.4) lines.push(`ERROR seed ${seed} run ${r} failed`);
      }
      expect(roundTrips(lines)).toBe(true);
    }
  });

  test('compressLog collapses a KEPT repetitive run (query-matched) into a block', () => {
    const lines = [
      'INFO build started',
      ...Array.from({ length: 150 }, (_, i) => `INFO compiled module ${i} in ${i % 50}ms`),
      'ERROR linker failed: undefined symbol foo',
      'Tests: 1 failed, 0 passed',
    ];
    const text = lines.join('\n');
    // The query keeps the repetitive run; mining then collapses it losslessly.
    const r = compressLog(text, { query: 'compiled module' });
    expect(r.strategy).toBe(ECompressionStrategy.Log);
    expect(r.savings.saved).toBeGreaterThan(0);
    expect(r.compressed).toContain('⟦×');
    expect(r.compressed).toContain('ERROR linker failed');
    expect(r.compressed).toContain('Tests: 1 failed');
  });

  test('P4.5: each elision hint carries the CCR key for in-place retrieval', () => {
    const store = new InMemoryCcrStore();
    const lines = [
      'INFO start',
      ...Array.from({ length: 30 }, (_, i) => `INFO routine work ${i}`),
      'ERROR boom at handler',
      ...Array.from({ length: 20 }, (_, i) => `INFO more routine ${i}`),
      'Tests: 1 failed, 0 passed',
    ];
    const r = compressLog(lines.join('\n'), { store });
    // The omitted markers reference the cached original, in place.
    expect(r.compressed).toMatch(/omitted → <<ccr:[0-9a-f]+>>/);
    const keys = parseCcrMarkers(r.compressed);
    expect(keys.length).toBeGreaterThan(0);
    expect(store.get(keys[0]!.key)!.content).toBe(lines.join('\n'));
    // No redundant trailing marker beyond the inline hints (same key reused).
    expect(r.ccrKey).toBe(keys[0]!.key);
  });

  test('compressLog does NOT bloat a noisy log: droppable runs stay elided, not mined', () => {
    // Per-line timestamps make a "lit" column; eliding the noise must still beat
    // keeping a template block. No query → the noise is dropped, not collapsed.
    const lines = [
      'INFO build started',
      ...Array.from(
        { length: 60 },
        (_, i) => `2026-06-16T10:00:${String(i % 60).padStart(2, '0')}Z INFO worker ${i % 4} batch ${i} ok`,
      ),
      'ERROR boom',
      'Tests: 1 failed, 0 passed',
    ];
    const r = compressLog(lines.join('\n'), { contentType: EContentType.BuildLog });
    // Strong reduction preserved (elision drops the noise to one marker).
    expect(1 - r.savings.after / r.savings.before).toBeGreaterThanOrEqual(0.6);
    expect(r.compressed).toContain('omitted');
    expect(r.compressed).toContain('ERROR boom');
  });
});
