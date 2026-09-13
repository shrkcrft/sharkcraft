/**
 * Round 11, 1.2#4 — the two project-root detectors agree.
 *
 * Root discovery exists twice: `@shrkcrft/config` (where the config loader
 * looks) and `@shrkcrft/workspace` (what `inspection.projectRoot` is). Two code
 * paths answering one question agree only by coincidence unless a property
 * test holds them together; deleting one is a later cleanup, so until then
 * this is the lock. `findConfiguredAncestor` (the hint behind the stale-check's
 * loud refusal) is exercised on the same layouts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectRoot as configRoot, findConfiguredAncestor } from '@shrkcrft/config';
import { detectProjectRoot as workspaceRoot } from '@shrkcrft/workspace';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'shrk-r75-roots-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function dir(rel: string, files: readonly string[] = []): string {
  const abs = join(base, rel);
  mkdirSync(abs, { recursive: true });
  for (const f of files) {
    if (f.endsWith('/')) mkdirSync(join(abs, f), { recursive: true });
    else writeFileSync(join(abs, f), f === 'package.json' ? '{"name":"x"}' : '');
  }
  return abs;
}

describe('config and workspace detectProjectRoot return the same root', () => {
  const layouts: Record<string, () => string> = {
    'a nested workspace package (stops at the nearest package.json)': () => {
      dir('nested', ['package.json', 'sharkcraft/']);
      return dir('nested/packages/sub', ['package.json']);
    },
    'a directory below the root with no marker (walks up)': () => {
      dir('walk', ['package.json']);
      return dir('walk/src/deep');
    },
    'a .git-only repository': () => {
      dir('gitonly', ['.git/']);
      return dir('gitonly/lib');
    },
  };
  for (const [name, make] of Object.entries(layouts)) {
    test(name, () => {
      const start = make();
      const a = configRoot(start);
      const b = workspaceRoot(start);
      expect(a.root).toBe(b.root);
      expect([...a.markers].sort()).toEqual([...b.markers].sort());
    });
  }
});

describe('findConfiguredAncestor — a hint, never a rebinding', () => {
  test('from a nested package without sharkcraft/, it names the configured ancestor', () => {
    const top = dir('hint', ['package.json', 'sharkcraft/']);
    const sub = dir('hint/packages/sub', ['package.json']);
    expect(findConfiguredAncestor(sub)).toBe(top);
  });

  test('it stops at the repository top (.git) and never climbs past it', () => {
    dir('outer', ['sharkcraft/']);
    dir('outer/repo', ['.git/', 'package.json']);
    const sub = dir('outer/repo/packages/sub', ['package.json']);
    expect(findConfiguredAncestor(sub)).toBeNull();
    // A root that IS the repository top has no in-repo ancestor to point at.
    expect(findConfiguredAncestor(join(base, 'outer/repo'))).toBeNull();
  });
});
