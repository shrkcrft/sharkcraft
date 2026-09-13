/**
 * r78 — a changed-scope read from a project NESTED in a larger git repository
 * names the project's own files (round 15 follow-up, lane B — B4).
 *
 * git names a path relative to the work-tree TOP LEVEL (`diff --name-only`,
 * `status --porcelain`), but every `getChangedFiles` caller resolves it
 * against the project root. For a project at `app/` inside a larger
 * repository, `conventions check --staged` / `--since` read `app/src/a.ts` as
 * `<root>/app/src/a.ts`, a file that does not exist. A `fileGlobs: ['src/**']`
 * convention then selected nothing and the check exited 2 (NOT VERIFIED), while
 * `--files src/a.ts` on the same tree exited 1 with the hit. `getChangedFiles`
 * now maps every path to project-relative and drops a change outside the
 * project. It forces `diff.relative` off so a user's config cannot change the
 * spelling. `gitShowFile` reads the same spelling (`<ref>:./<path>`).
 *
 * A real git repository inside a temp dir. The CLI is spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getChangedFiles, gitShowFile } from '@shrkcrft/inspector';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'user.email=r78@example.invalid', '-c', 'user.name=r78', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['--no-install', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * <top>/README.md, <top>/other/x.ts (a sibling of the project) and the project
 * at <top>/app. Committed, then app/src/a.ts and other/x.ts are edited and
 * staged, and app/src/new.ts is left untracked.
 */
const top = ((): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-nested-git-'));
  roots.push(dir);
  write(dir, 'README.md', 'top\n');
  write(dir, 'other/x.ts', 'export const x = 1;\n');
  write(dir, 'app/package.json', JSON.stringify({ name: 'app', version: '0.0.0' }));
  write(dir, 'app/tsconfig.json', '{}');
  write(dir, 'app/sharkcraft/sharkcraft.config.ts', "export default { projectName: 'app' };\n");
  write(
    dir,
    'app/sharkcraft/conventions.ts',
    `export default ${JSON.stringify(
      [
        {
          id: 'c.no-ts',
          title: 'no ts in src',
          kind: 'naming',
          severity: 'error',
          appliesTo: { fileGlobs: ['src/**'] },
          rules: [{ id: 'no-ts', description: 'no .ts file', forbidMatch: '\\.ts$' }],
        },
      ],
      null,
      2,
    )};\n`,
  );
  write(dir, 'app/src/a.ts', 'export const a = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  write(dir, 'app/src/a.ts', 'export const a = 2;\n');
  write(dir, 'other/x.ts', 'export const x = 2;\n');
  git(dir, 'add', 'app/src/a.ts', 'other/x.ts');
  write(dir, 'app/src/new.ts', 'export const n = 1;\n');
  return dir;
})();
const app = join(top, 'app');

/**
 * A project at the repository TOP LEVEL (package.json beside .git): src/a.ts and
 * src/sub/b.ts committed, then edited and staged. The review case: a command
 * run from a SUBDIRECTORY (`--cwd src`, or a shell in src/) — the inspection's
 * project root walks up to the top (`detectProjectRoot`), so the changed scope
 * must be spelled relative to it too.
 */
const flat = ((): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-flat-git-'));
  roots.push(dir);
  write(dir, 'package.json', JSON.stringify({ name: 'flat', version: '0.0.0' }));
  write(dir, 'sharkcraft/sharkcraft.config.ts', "export default { projectName: 'flat' };\n");
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  write(dir, 'src/sub/b.ts', 'export const b = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  write(dir, 'src/a.ts', 'export const a = 2;\n');
  write(dir, 'src/sub/b.ts', 'export const b = 2;\n');
  git(dir, 'add', '-A');
  return dir;
})();

describe('r78 B4 — getChangedFiles is project-relative for a nested project', () => {
  test('staged / since / working tree: the project’s files in its own spelling, nothing from outside it', () => {
    expect(getChangedFiles(app, { staged: true })).toEqual(['src/a.ts']);
    expect(getChangedFiles(app, { since: 'HEAD' })).toEqual(['src/a.ts']);
    expect(getChangedFiles(app, { includeWorktree: true })).toEqual(['src/a.ts', 'src/new.ts']);
    // At the top level nothing changes: every path, top-level-relative.
    expect(getChangedFiles(top, { staged: true })).toEqual(['app/src/a.ts', 'other/x.ts']);
  });

  test('a user `diff.relative = true` config cannot change the spelling', () => {
    git(top, 'config', 'diff.relative', 'true');
    try {
      expect(getChangedFiles(app, { staged: true })).toEqual(['src/a.ts']);
      expect(getChangedFiles(app, { since: 'HEAD' })).toEqual(['src/a.ts']);
      expect(getChangedFiles(top, { staged: true })).toEqual(['app/src/a.ts', 'other/x.ts']);
    } finally {
      git(top, 'config', '--unset', 'diff.relative');
    }
  });

  test('gitShowFile reads a changed file at the ref in the same project-relative spelling', () => {
    expect(gitShowFile(app, 'HEAD', 'src/a.ts')).toBe('export const a = 1;\n');
    expect(gitShowFile(app, 'HEAD', 'src/new.ts')).toBeNull();
    expect(gitShowFile(top, 'HEAD', 'app/src/a.ts')).toBe('export const a = 1;\n');
  });
});

describe('r78 B4 — `conventions check --staged / --since` from a nested project', () => {
  test(
    '--staged and --since HEAD find the hit on src/a.ts (exit 1), as --files does — never "not applicable" at 2',
    () => {
      const staged = shrk(app, ['conventions', 'check', '--staged', '--json']);
      expect(staged.status).toBe(1);
      const body = JSON.parse(staged.stdout) as { hits: { file: string; conventionId: string }[]; notApplicable: unknown[] };
      expect(body.hits.map((h) => `${h.conventionId}:${h.file}`)).toEqual(['c.no-ts:src/a.ts']);
      expect(body.notApplicable).toEqual([]);

      const since = shrk(app, ['conventions', 'check', '--since', 'HEAD']);
      expect(since.status).toBe(1);
      expect(since.stdout).toContain('c.no-ts/no-ts — src/a.ts');
      expect(since.stdout).not.toContain('other/x.ts');
    },
    T,
  );

  test(
    'a --cwd below the project root reads the same scope (the git scope is taken from the project root)',
    () => {
      const r = shrk(top, ['--cwd', join(app, 'src'), 'conventions', 'check', '--staged', '--json']);
      expect(r.status).toBe(1);
      const body = JSON.parse(r.stdout) as { hits: { file: string }[] };
      expect(body.hits.map((h) => h.file)).toEqual(['src/a.ts']);
    },
    T,
  );
});

/**
 * Review finding: the B4 fix spelled paths relative to the RAW `cwd`. A command
 * run from a subdirectory inspects the project root `detectProjectRoot` walks
 * up to, so `getChangedFiles(<root>/src)` returning `a.ts` was resolved as
 * `<root>/a.ts`: `validate-change --staged --cwd src` listed `a.ts`,
 * `sub/b.ts` where HEAD (top-level spelling, = the root's for a top-level
 * project) listed `src/a.ts`, `src/sub/b.ts`. Paths are root-relative now.
 */
describe('r78 B4 review — a changed scope read from a SUBDIRECTORY is spelled from the project root', () => {
  test('top-level project: from src/ and src/sub/ the paths are the root’s (the spelling HEAD read), not cwd-relative', () => {
    const want = ['src/a.ts', 'src/sub/b.ts'];
    expect(getChangedFiles(flat, { staged: true })).toEqual(want);
    expect(getChangedFiles(join(flat, 'src'), { staged: true })).toEqual(want);
    expect(getChangedFiles(join(flat, 'src', 'sub'), { since: 'HEAD' })).toEqual(want);
    expect(gitShowFile(join(flat, 'src'), 'HEAD', 'src/a.ts')).toBe('export const a = 1;\n');
  });

  test('nested project: from app/src the paths are app-relative, and gitShowFile reads the same spelling', () => {
    expect(getChangedFiles(join(app, 'src'), { staged: true })).toEqual(['src/a.ts']);
    expect(gitShowFile(join(app, 'src'), 'HEAD', 'src/a.ts')).toBe('export const a = 1;\n');
  });

  test(
    '`validate-change --staged` and `git changed --staged` from --cwd src name the project-root paths',
    () => {
      const v = shrk(flat, ['--cwd', join(flat, 'src'), 'validate-change', '--staged', '--format', 'json']);
      expect(v.status).toBe(0);
      expect((JSON.parse(v.stdout) as { changedFiles: string[] }).changedFiles).toEqual(['src/a.ts', 'src/sub/b.ts']);
      const g = shrk(flat, ['--cwd', join(flat, 'src'), 'git', 'changed', '--staged', '--json']);
      expect(g.status).toBe(0);
      expect((JSON.parse(g.stdout) as { files: string[] }).files).toEqual(['src/a.ts', 'src/sub/b.ts']);
    },
    T,
  );
});
