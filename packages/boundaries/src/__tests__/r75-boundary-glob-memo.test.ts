/**
 * Round 11 (6.3) — `globToRegex` is memoised and bounded.
 *
 * `matchesAny` recompiled a pattern on every test — once per edge × pattern —
 * which was the dominant cost of a boundary run at scale. The memo must not
 * change a single match (glob.test.ts still pins the semantics, `*` never
 * crossing `/`), and it must stay bounded.
 */
import { describe, expect, test } from 'bun:test';
import {
  GLOB_REGEX_CACHE_LIMIT,
  globRegexCacheSize,
  globToRegex,
  matchesAny,
} from '../scan/glob.ts';

const SAMPLES: readonly [string, string, boolean][] = [
  ['libs/demo/core/**', 'libs/demo/core/src/index.ts', true],
  ['libs/**/index.ts', 'libs/index.ts', true],
  ['@demo/ui-*', '@demo/ui-angular', true],
  ['@demo/ui-*', '@demo/ui-angular/internal', false],
  ['src/?.ts', 'src/a.ts', true],
  ['src/?.ts', 'src/ab.ts', false],
];

describe('globToRegex memo', () => {
  test('a repeated pattern returns the SAME compiled instance, with unchanged results', () => {
    for (const [pattern, value, expected] of SAMPLES) {
      const first = globToRegex(pattern);
      const second = globToRegex(pattern);
      expect(second).toBe(first);
      expect(first.test(value)).toBe(expected);
      expect(first.flags).toBe(''); // no g/y — sharing an instance is stateless
    }
  });

  test('matchesAny answers exactly as before through the memo', () => {
    expect(matchesAny('@demo/ui-angular', ['@demo/core-*', '@demo/ui-*'])).toBe(true);
    expect(matchesAny('react', ['@demo/core-*'])).toBe(false);
  });

  test('the cache is bounded, and matches stay correct after it starts over', () => {
    for (let i = 0; i < GLOB_REGEX_CACHE_LIMIT + 50; i += 1) globToRegex(`gen/${i}/**`);
    expect(globRegexCacheSize()).toBeLessThanOrEqual(GLOB_REGEX_CACHE_LIMIT);
    for (const [pattern, value, expected] of SAMPLES) expect(globToRegex(pattern).test(value)).toBe(expected);
  });
});
