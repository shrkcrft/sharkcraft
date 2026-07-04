import { describe, expect, test } from 'bun:test';
import { parseDelegateAnalysis } from '../delegate/parse-delegate-analysis.ts';

describe('parseDelegateAnalysis', () => {
  test('parses a well-formed analysis', () => {
    const r = parseDelegateAnalysis(
      JSON.stringify({ findings: [{ id: 'f1', message: 'risky', refs: ['src/a.ts'] }], note: 'hi' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.findings).toHaveLength(1);
      expect(r.value.findings[0]?.refs).toEqual(['src/a.ts']);
      expect(r.value.note).toBe('hi');
    }
  });

  test('accepts a finding with only a message (refs/id optional)', () => {
    const r = parseDelegateAnalysis(JSON.stringify({ findings: [{ message: 'general observation' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.findings[0]?.refs).toBeUndefined();
  });

  test('strips a markdown code fence weak models add', () => {
    const r = parseDelegateAnalysis('```json\n{"findings":[{"message":"x"}]}\n```');
    expect(r.ok).toBe(true);
  });

  test('rejects non-JSON', () => {
    expect(parseDelegateAnalysis('not json at all').ok).toBe(false);
  });

  test('rejects when findings is missing', () => {
    expect(parseDelegateAnalysis(JSON.stringify({ note: 'x' })).ok).toBe(false);
  });

  test('rejects a finding with a non-string message', () => {
    expect(parseDelegateAnalysis(JSON.stringify({ findings: [{ message: 42 }] })).ok).toBe(false);
  });

  test('rejects refs that are not an array of strings', () => {
    expect(parseDelegateAnalysis(JSON.stringify({ findings: [{ message: 'x', refs: [1, 2] }] })).ok).toBe(false);
  });

  test('rejects an empty string', () => {
    expect(parseDelegateAnalysis('   ').ok).toBe(false);
  });
});
