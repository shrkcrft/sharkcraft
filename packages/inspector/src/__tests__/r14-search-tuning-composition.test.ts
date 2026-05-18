import { describe, expect, test } from 'bun:test';
import { tuningBoostFor, type ISearchTuningEntry } from '../index.ts';

function tuning(over: Partial<ISearchTuningEntry>): ISearchTuningEntry {
  return {
    id: over.id ?? 'test',
    source: 'local',
    sourceFile: '(test)',
    ...over,
  };
}

describe('r14 search tuning composition', () => {
  test('sum (default) adds contributions from multiple tunings on the same key', () => {
    const entries: ISearchTuningEntry[] = [
      tuning({ id: 'a', boostTags: { plugin: 2 } }),
      tuning({ id: 'b', boostTags: { plugin: 3 } }),
    ];
    const result = tuningBoostFor(
      { id: 'doc1', kind: 'rule', tags: ['plugin'], source: 'local' },
      [],
      entries,
    );
    expect(result.delta).toBe(5);
    const comp = result.composition?.find((c) => c.key === 'tag:plugin');
    expect(comp?.strategy).toBe('sum');
    expect(comp?.combined).toBe(5);
  });

  test('max wins when any contributor declares mergeStrategy=max', () => {
    const entries: ISearchTuningEntry[] = [
      tuning({ id: 'a', mergeStrategy: 'max', boostTags: { plugin: 2 } }),
      tuning({ id: 'b', boostTags: { plugin: 3 } }),
    ];
    const result = tuningBoostFor(
      { id: 'doc1', kind: 'rule', tags: ['plugin'], source: 'local' },
      [],
      entries,
    );
    // max wins → 3 instead of 5
    expect(result.delta).toBe(3);
    const comp = result.composition?.find((c) => c.key === 'tag:plugin');
    expect(comp?.strategy).toBe('max');
    expect(comp?.combined).toBe(3);
  });

  test('caps still clamp the final delta', () => {
    const entries: ISearchTuningEntry[] = [
      // Single-tuning boosts are pre-clamped to ±5 by sanitize; here we
      // exercise the global ±10 cap by summing two big boosts on different keys.
      tuning({ id: 'a', boostTags: { plugin: 5 }, boostIds: { docX: 5 } }),
      tuning({ id: 'b', boostTags: { plugin: 5 } }),
    ];
    const result = tuningBoostFor(
      { id: 'docX', kind: 'rule', tags: ['plugin'], source: 'local' },
      [],
      entries,
    );
    // sum: 5+5 (tag) + 5 (id) = 15 → capped to 10.
    expect(result.delta).toBe(10);
  });

  test('explain composition shows contributors for multi-tuning keys', () => {
    const entries: ISearchTuningEntry[] = [
      tuning({ id: 'a', boostTags: { plugin: 2 } }),
      tuning({ id: 'b', boostTags: { plugin: 1 } }),
    ];
    const result = tuningBoostFor(
      { id: 'doc1', kind: 'rule', tags: ['plugin'], source: 'local' },
      [],
      entries,
    );
    const comp = result.composition?.find((c) => c.key === 'tag:plugin');
    expect(comp?.contributors.length).toBe(2);
    expect(comp?.contributors.map((c) => c.tuningId).sort()).toEqual(['a', 'b']);
  });
});
