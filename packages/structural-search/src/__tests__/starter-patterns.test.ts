import { describe, expect, test } from 'bun:test';
import {
  STARTER_PATTERNS,
  STRUCTURAL_PATTERN_SCHEMA,
  validatePatternEnvelope,
} from '../index.ts';

describe('STARTER_PATTERNS', () => {
  test('every starter has the canonical schema, an id, and a known kind', () => {
    for (const p of STARTER_PATTERNS) {
      expect(p.schema).toBe(STRUCTURAL_PATTERN_SCHEMA);
      expect(typeof p.id).toBe('string');
      expect(p.id!.length).toBeGreaterThan(0);
      expect(typeof p.pattern.kind).toBe('string');
    }
  });

  test('every starter passes validatePatternEnvelope', () => {
    for (const p of STARTER_PATTERNS) {
      const r = validatePatternEnvelope(p);
      expect(r.ok).toBe(true);
    }
  });

  test('starter ids are unique', () => {
    const ids = STARTER_PATTERNS.map((p) => p.id!);
    const set = new Set(ids);
    expect(set.size).toBe(ids.length);
  });

  test('starter set is reasonably sized (>= 5, <= 50)', () => {
    expect(STARTER_PATTERNS.length).toBeGreaterThanOrEqual(5);
    expect(STARTER_PATTERNS.length).toBeLessThanOrEqual(50);
  });
});
