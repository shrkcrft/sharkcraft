/**
 * r75 — a directory the walk could not LIST is an unread entry, never a silent
 * `return` (round 11 review R12-GAP-1).
 *
 * Both walkers (`scanImports`' and `walkMatching` under `readMatchingFiles`)
 * used to swallow a `readdirSync` failure, so every file beneath a `chmod 000`
 * directory dropped out of every rule's scope and a violation there read as a
 * clean pass with full coverage. The entry is `{ path: 'dir/', reason:
 * unreadable-directory }`, in front of every glob that could match beneath it
 * (`globMayMatchUnder`) and taken out of scope only by an exemption covering
 * ALL of it (`globCoversAllUnder`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globCoversAllUnder, globMayMatchUnder } from '../scan/glob.ts';
import { scanImports } from '../scan/scan-imports.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import {
  unreadEntryMatches,
  unreadEntryWhollyMatches,
  unreadMatching,
  unreadReason,
} from '../util/read-scope-coverage.ts';
import { UnreadFileReason } from '../util/unread-file-reason.ts';

const CANNOT_CHMOD =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const roots: string[] = [];
const lockedDirs: string[] = [];
afterAll(() => {
  for (const d of lockedDirs) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // already gone
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-unlistable-'));
  roots.push(root);
  const files: Record<string, string> = {
    'src/app/sub/a.ts': "import { B } from '@scope/ui';\nexport const a = B;\n",
    'src/app/b.ts': 'export const b = 1;\n',
    'lib/c.ts': 'export const c = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function lockDir(root: string, rel: string): void {
  const abs = join(root, rel);
  chmodSync(abs, 0o000);
  lockedDirs.push(abs);
}

const DIR = { path: 'src/app/sub/', reason: UnreadFileReason.UnreadableDirectory };

describe('the glob predicates — one-directional, never a false "cannot reach"', () => {
  test('globMayMatchUnder', () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ['src/app/**', 'src/app/sub/', true],
      ['src/**/*.ts', 'src/app/sub/', true],
      ['**/*.ts', 'anything/deep/', true],
      ['src/app/*.ts', 'src/app/sub/', false],
      ['src/app/*.ts', 'src/app/', true],
      ['src/app/**', 'src/', true],
      ['lib/**', 'src/app/sub/', false],
      ['src/app/a.ts', 'src/app/', true],
      ['src/app', 'src/app/', false],
      ['src/*/sub/*.ts', 'src/app/sub/', true],
      ['src/*/other/*.ts', 'src/app/sub/', false],
      ['src/**', './', true],
    ];
    for (const [glob, dir, want] of cases) expect({ glob, dir, got: globMayMatchUnder(glob, dir) }).toEqual({ glob, dir, got: want });
  });

  test('globCoversAllUnder — only an exemption covering ALL of the directory takes it out of scope', () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ['src/app/sub/**', 'src/app/sub/', true],
      ['src/app/**', 'src/app/sub/', true],
      ['src/*/sub/**', 'src/app/sub/deep/', true],
      ['**', 'src/app/sub/', true],
      ['src/app/sub/*.ts', 'src/app/sub/', false],
      ['**/*.spec.ts', 'src/app/sub/', false],
      ['lib/**', 'src/app/sub/', false],
    ];
    for (const [glob, dir, want] of cases) expect({ glob, dir, got: globCoversAllUnder(glob, dir) }).toEqual({ glob, dir, got: want });
  });

  test('the unread-entry tests: a file by its path, a directory by what could lie beneath it', () => {
    expect(unreadEntryMatches(DIR, ['src/app/**'])).toBe(true);
    expect(unreadEntryMatches(DIR, ['src/app/*.ts'])).toBe(false);
    expect(unreadEntryWhollyMatches(DIR, ['src/app/sub/**'])).toBe(true);
    expect(unreadEntryWhollyMatches(DIR, ['**/*.spec.ts'])).toBe(false);
    const file = { path: 'src/app/b.ts', reason: UnreadFileReason.Unreadable };
    expect(unreadEntryMatches(file, ['src/app/*.ts'])).toBe(true);
    expect(unreadReason([DIR])).toContain('unlistable');
  });

  test('under a changeset, the directory contributes the CHANGED files beneath it that the globs match', () => {
    const got = unreadMatching([DIR], ['src/**/*.ts'], new Set(['src/app/sub/a.ts', 'src/app/b.ts', 'README.md']));
    expect(got).toEqual([{ path: 'src/app/sub/a.ts', reason: UnreadFileReason.Unreadable }]);
    expect(unreadMatching([DIR], ['src/**/*.ts'], new Set(['src/app/b.ts']))).toEqual([]);
  });
});

describe('both walkers report an unlistable directory', () => {
  test.skipIf(CANNOT_CHMOD)('readMatchingFiles: unread for a glob that reaches beneath it, absent for one that cannot', () => {
    const root = tree();
    lockDir(root, 'src/app/sub');
    const reaching = readMatchingFiles(root, ['src/**/*.ts']);
    expect([...reaching.files.keys()]).toEqual(['src/app/b.ts']);
    expect(reaching.unread).toEqual([DIR]);
    const notReaching = readMatchingFiles(root, ['src/app/*.ts', 'lib/**']);
    expect(notReaching.unread).toEqual([]);
  });

  test.skipIf(CANNOT_CHMOD)('scanImports: unread (never scanned), with a warning; `include` narrows it like a file', () => {
    const root = tree();
    lockDir(root, 'src/app/sub');
    const scan = scanImports({ projectRoot: root });
    expect(scan.unread).toEqual([DIR]);
    expect(scan.files).not.toContain('src/app/sub/a.ts');
    expect(scan.warnings.some((w) => w.includes('src/app/sub/'))).toBe(true);
    expect(scanImports({ projectRoot: root, include: ['lib/**'] }).unread).toEqual([]);
    expect(scanImports({ projectRoot: root, include: ['src/app/**'] }).unread).toEqual([DIR]);
  });
});
