/**
 * r75 — the `recommend` config key (spec 2.2): a strict object carrying the
 * recommender's floor multiplier and the create-intent scaffold gate. The
 * top-level schema is strict, so an undeclared key would drop the WHOLE config.
 */
import { describe, expect, test } from 'bun:test';
import { SharkCraftConfigSchema } from '../config-schema.ts';

describe('r75 config: recommend', () => {
  test('accepts recommend.minScore and recommend.scaffoldRequiresCreateIntent', () => {
    const parsed = SharkCraftConfigSchema.safeParse({
      recommend: { minScore: 1.5, scaffoldRequiresCreateIntent: false },
    });
    expect(parsed.success).toBe(true);
  });

  test('rejects an unknown key inside recommend', () => {
    const parsed = SharkCraftConfigSchema.safeParse({ recommend: { minScroe: 2 } });
    expect(parsed.success).toBe(false);
  });

  test('rejects a non-positive floor', () => {
    expect(SharkCraftConfigSchema.safeParse({ recommend: { minScore: 0 } }).success).toBe(false);
    expect(SharkCraftConfigSchema.safeParse({ recommend: { minScore: -1 } }).success).toBe(false);
  });
});
