import { describe, expect, test } from 'bun:test';
import {
  isPlainObject,
  buildPresenceMap,
  passesHeterogeneityGate,
  sortColumnsByPresence,
} from '../table/column-presence.ts';

describe('column-presence (shared compactor logic)', () => {
  test('isPlainObject narrows to plain objects only', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('s')).toBe(false);
    expect(isPlainObject(42)).toBe(false);
  });

  test('buildPresenceMap counts present keys (undefined counts as absent)', () => {
    const p = buildPresenceMap([
      { a: 1, b: 2 },
      { a: 3, b: undefined, c: 4 },
      { a: 5 },
    ]);
    expect(p.get('a')).toBe(3);
    expect(p.get('b')).toBe(1); // the undefined occurrence is not counted
    expect(p.get('c')).toBe(1);
  });

  test('heterogeneity gate: homogeneous passes, sparse/empty fails', () => {
    const homogeneous = buildPresenceMap(Array.from({ length: 10 }, (_, i) => ({ a: i, b: i, c: i })));
    expect(passesHeterogeneityGate(homogeneous, 10)).toBe(true);

    // Every record has a unique key → no shared columns → not worth hoisting.
    const sparse = buildPresenceMap(Array.from({ length: 10 }, (_, i) => ({ [`k${i}`]: i })));
    expect(passesHeterogeneityGate(sparse, 10)).toBe(false);

    expect(passesHeterogeneityGate(new Map(), 5)).toBe(false);
  });

  test('sortColumnsByPresence: most-present first, ties broken by name', () => {
    const presence = new Map<string, number>([
      ['rare', 1],
      ['common', 9],
      ['mid', 5],
      ['alsoMid', 5],
    ]);
    expect(sortColumnsByPresence(presence)).toEqual(['common', 'alsoMid', 'mid', 'rare']);
  });
});
