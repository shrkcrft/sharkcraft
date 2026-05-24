import { describe, expect, test } from 'bun:test';
import { deriveApplicability } from '../bridge/knowledge-rule-matching.ts';

describe('deriveApplicability', () => {
  test('uses metadata.appliesTo when present', () => {
    const a = deriveApplicability({ metadata: { appliesTo: ['src/**/*.ts'] }, tags: ['ignored'] });
    expect(a.source).toBe('metadata');
    expect(a.patterns).toEqual(['src/**/*.ts']);
  });

  test('falls back to tag-based heuristics', () => {
    const a = deriveApplicability({ tags: ['mcp'] });
    expect(a.source).toBe('tags');
    expect(a.patterns).toContain('packages/mcp-server/**');
  });

  test('combines patterns from multiple tags', () => {
    const a = deriveApplicability({ tags: ['mcp', 'dashboard'] });
    expect(a.patterns).toContain('packages/mcp-server/**');
    expect(a.patterns).toContain('packages/dashboard/**');
  });

  test('testing/tests tags add fileTags rather than patterns', () => {
    const a = deriveApplicability({ tags: ['testing'] });
    expect(a.source).toBe('tags');
    expect(a.fileTags).toContain('test');
    expect(a.patterns).toEqual([]);
  });

  test('returns source=none when no signal matches', () => {
    const a = deriveApplicability({ tags: ['random-unknown-tag'] });
    expect(a.source).toBe('none');
  });

  test('handles missing tags + metadata gracefully', () => {
    expect(deriveApplicability({}).source).toBe('none');
  });
});
