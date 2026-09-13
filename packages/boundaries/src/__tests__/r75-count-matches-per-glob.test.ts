/**
 * Round 11 (L-4) — `countMatchesPerGlob`, the one per-glob authority.
 *
 * `matchesAny` answers "is this file in scope" by collapsing a glob list into
 * one yes/no, which hides exactly the defect a directory rename produces: one
 * glob of a rule's `files[]` matching nothing while its siblings keep the rule
 * connected. The per-glob count is that missing signal, and every plane that
 * reports a dead unit (the gate planes here, the boundary plane's scope globs)
 * reads it from this one function.
 */
import { describe, expect, test } from 'bun:test';
import { countMatchesPerGlob, globListSelects } from '../scan/glob.ts';

const PATHS = ['src/handlers/a.ts', 'src/handlers/b.ts', 'src/registry.ts', 'lib/deep/x.ts'];

describe('countMatchesPerGlob', () => {
  test('a glob no path matches counts 0; the others count their real matches, in first-seen order', () => {
    expect([
      ...countMatchesPerGlob(PATHS, ['src/handlers/*.ts', 'src/renamed-away/*.ts', 'lib/**/*.ts']),
    ]).toEqual([
      ['src/handlers/*.ts', 2],
      ['src/renamed-away/*.ts', 0],
      ['lib/**/*.ts', 1],
    ]);
  });

  test('a glob listed twice is counted once', () => {
    const counts = countMatchesPerGlob(PATHS, ['src/*.ts', 'src/*.ts']);
    expect(counts.size).toBe(1);
    expect(counts.get('src/*.ts')).toBe(1);
  });

  test('`*` still does not cross `/` — the same glob semantics as matchesAny', () => {
    expect(countMatchesPerGlob(['src/a/b.ts'], ['src/*.ts']).get('src/*.ts')).toBe(0);
    expect(countMatchesPerGlob(['src/a/b.ts'], ['src/**/*.ts']).get('src/**/*.ts')).toBe(1);
  });

  test('no paths → every glob is dead; no globs → an empty map', () => {
    expect([...countMatchesPerGlob([], ['a/*.ts', 'b/**'])]).toEqual([
      ['a/*.ts', 0],
      ['b/**', 0],
    ]);
    expect(countMatchesPerGlob(PATHS, []).size).toBe(0);
  });

  // Round 12 (12.2): the per-glob count reads the same scope authority the
  // engines select with (`globListSelects`), so the property is stated over
  // INCLUSION globs — a negation's count is what it excluded, not a selection.
  test('PROPERTY: a path is counted under some inclusion glob iff globListSelects puts it in scope', () => {
    const lists = [
      ['src/**/*.ts', 'lib/*.ts', 'nowhere/**'],
      ['src/**/*.ts', '!src/deep/**', 'lib/*.ts'],
      ['!**/b.ts', 'src/**/*.ts'],
    ];
    for (const globs of lists) {
      for (const p of [...PATHS, 'lib/y.ts', 'other/z.ts', 'src/deep/er/q.ts']) {
        const counted = [...countMatchesPerGlob([p], globs)].some(([g, n]) => !g.startsWith('!') && n > 0);
        expect({ p, globs, counted }).toEqual({ p, globs, counted: globListSelects(p, globs) });
      }
    }
  });

  test('a negation counts the files it EXCLUDES from its own list; an inclusion glob counts what survives', () => {
    const paths = ['src/a.ts', 'src/a.spec.ts', 'src/b.spec.ts', 'lib/c.spec.ts'];
    expect([...countMatchesPerGlob(paths, ['src/**/*.ts', '!**/*.spec.ts'])]).toEqual([
      ['src/**/*.ts', 1],
      // lib/c.spec.ts is outside the list's positive set, so it was never "excluded".
      ['!**/*.spec.ts', 2],
    ]);
  });
});
