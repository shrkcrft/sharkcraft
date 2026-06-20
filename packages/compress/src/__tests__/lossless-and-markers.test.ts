import { describe, expect, test } from 'bun:test';
import {
  compressContent,
  ECompressionStrategy,
  EContentType,
  InMemoryCcrStore,
} from '../index.ts';

/** A markdown doc that the lossy markdown compressor will elide. */
function lossyMarkdown(): string {
  const lines = ['# Title', ''];
  for (let i = 0; i < 40; i += 1) lines.push(`- bullet point number ${i} with some filler text to drop`);
  return lines.join('\n');
}

/** A homogeneous JSON array the LOSSLESS columnar strategy compresses. */
function jsonArray(): string {
  return JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: 'rule', title: `Title ${i}` })),
  );
}

describe('lossless guard (--lossless)', () => {
  test('refuses a lossy reduction: a lossy markdown pass falls back to passthrough', () => {
    const md = lossyMarkdown();
    const lossy = compressContent(md, { store: new InMemoryCcrStore() });
    expect(lossy.lossy).toBe(true); // baseline: it WOULD compress lossily

    const guarded = compressContent(md, { store: new InMemoryCcrStore(), lossless: true });
    expect(guarded.lossy).toBe(false);
    expect(guarded.strategy).toBe(ECompressionStrategy.Passthrough);
    expect(guarded.compressed).toBe(md); // verbatim — nothing dropped
  });

  test('still allows a provably-lossless reduction (JSON columnar table)', () => {
    const json = jsonArray();
    const guarded = compressContent(json, { lossless: true });
    expect(guarded.lossy).toBe(false);
    expect(guarded.strategy).toBe(ECompressionStrategy.Table);
    expect(guarded.savings.saved).toBeGreaterThan(0);
  });
});

describe('keyed elision markers', () => {
  test('each "… N lines omitted" marker names the recovery key when cached', () => {
    const result = compressContent(lossyMarkdown(), { store: new InMemoryCcrStore() });
    expect(result.lossy).toBe(true);
    expect(result.ccrKey).toBeDefined();
    expect(result.compressed).toContain('lines omitted (shrk expand ');
    expect(result.compressed).toContain(`(shrk expand ${result.ccrKey})`);
  });

  test('no double-annotation and no key leak without a store', () => {
    const result = compressContent(lossyMarkdown(), {}); // no store → no key
    // Without a store the lossy pass nets a loss-or-not; either way no key hint.
    expect(result.compressed).not.toContain('(shrk expand ');
    expect(result.contentType).toBe(EContentType.Markdown);
  });
});
