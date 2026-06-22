import { describe, expect, test } from 'bun:test';
import { hasCallGraphReferences } from '../indexer/call-graph-support.ts';

describe('hasCallGraphReferences', () => {
  test('TS/JS family (and unknown) are call-graph-tracked', () => {
    expect(hasCallGraphReferences('typescript')).toBe(true);
    expect(hasCallGraphReferences('javascript')).toBe(true);
    expect(hasCallGraphReferences(undefined)).toBe(true);
  });

  test('dedicated non-TS extractor languages are NOT tracked', () => {
    for (const lang of ['go', 'python', 'java', 'rust', 'kotlin', 'ruby', 'csharp', 'php']) {
      expect(hasCallGraphReferences(lang)).toBe(false);
    }
  });
});
