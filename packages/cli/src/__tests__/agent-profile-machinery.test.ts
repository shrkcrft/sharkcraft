import { describe, expect, test } from 'bun:test';
import { getProfile } from '../surface/profiles.ts';

describe('agent surface profile', () => {
  const agent = getProfile('agent')!;
  const hidden = new Set(agent.hidden ?? []);

  test('hides CI / release / pack-maintenance machinery verbs', () => {
    for (const cmd of ['packs sign', 'bundle create']) {
      expect(hidden.has(cmd)).toBe(true);
    }
    // The category derivation fired (not just the 6 interactive verbs).
    expect(hidden.size).toBeGreaterThan(80);
  });

  test('keeps core coding verbs visible', () => {
    for (const cmd of ['gen', 'apply', 'context', 'graph', 'why', 'diff-check', 'check boundaries']) {
      expect(hidden.has(cmd)).toBe(false);
    }
  });

  test('keeps read-only pack discovery visible despite hiding the packs category', () => {
    expect(hidden.has('packs list')).toBe(false);
    expect(hidden.has('packs doctor')).toBe(false);
  });
});
