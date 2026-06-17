import { describe, expect, test } from 'bun:test';
import { loadRealTokenizer, realTokens } from '../lib/real-tokens.ts';

describe('real-tokens (measurement-only BPE tokenizer)', () => {
  test('loads gpt-tokenizer and counts tokens for a known string', async () => {
    const tok = await loadRealTokenizer();
    // The dev dependency is present in this repo; if it ever isn't, this asserts
    // we noticed rather than silently degrading.
    expect(tok).not.toBeNull();
    const count = tok!('the quick brown fox');
    expect(count).toBeGreaterThan(0);
    // Empty string is always zero tokens.
    expect(tok!('')).toBe(0);
  });

  test('degrades to null when the tokenizer dependency cannot be loaded', async () => {
    const tok = await loadRealTokenizer('this-module-does-not-exist-xyz');
    expect(tok).toBeNull();
  });

  test('realTokens convenience returns a count, or null when absent', async () => {
    expect(await realTokens('hello world')).toBeGreaterThan(0);
    expect(await realTokens('', 'this-module-does-not-exist-xyz')).toBeNull();
    expect(await realTokens('hello', 'this-module-does-not-exist-xyz')).toBeNull();
  });
});
