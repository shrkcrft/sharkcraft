import { describe, expect, test } from 'bun:test';
import { globToRegex, matchesAny } from '../scan/glob.ts';

describe('globToRegex', () => {
  test('** matches multiple path segments', () => {
    const re = globToRegex('libs/demo/core/**');
    expect(re.test('libs/demo/core/src/index.ts')).toBe(true);
    expect(re.test('libs/demo/core/a/b/c.ts')).toBe(true);
    expect(re.test('libs/demo/common/foo.ts')).toBe(false);
  });

  test('a/** /b matches a/b and a/x/b', () => {
    const re = globToRegex('libs/**/index.ts');
    expect(re.test('libs/index.ts')).toBe(true);
    expect(re.test('libs/demo/core/index.ts')).toBe(true);
    expect(re.test('libs/demo/foo.ts')).toBe(false);
  });

  test('* matches any chars except /', () => {
    const re = globToRegex('@demo/ui-*');
    expect(re.test('@demo/ui-angular')).toBe(true);
    expect(re.test('@demo/ui-angular/internal')).toBe(false);
    expect(re.test('@demo/adapter-core')).toBe(false);
  });

  test('matchesAny short-circuits on first match', () => {
    expect(matchesAny('@demo/ui-angular', ['@demo/core-*', '@demo/ui-*'])).toBe(true);
    expect(matchesAny('react', ['@demo/core-*'])).toBe(false);
  });
});
