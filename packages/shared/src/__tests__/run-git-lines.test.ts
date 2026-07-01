import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitLines } from '../run-git-lines.ts';

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
  }
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-git-lines-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

describe('runGitLines', () => {
  test('captures a clean name listing as trimmed lines', () => {
    const root = initRepo();
    try {
      const res = runGitLines(root, ['rev-parse', '--is-inside-work-tree']);
      expect(res.ok).toBe(true);
      expect(res.lines).toEqual(['true']);
      expect(res.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('surfaces a deleted file via diff --name-status (the orphan-check path)', () => {
    const root = initRepo();
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
      unlinkSync(join(root, 'a.ts'));

      const res = runGitLines(root, ['diff', '--name-status', 'HEAD']);
      expect(res.ok).toBe(true);
      // One status-prefixed line per change; the deleted file carries `D`.
      const deleted = res.lines
        .map((l) => l.match(/^D\s+(.+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1]);
      expect(deleted).toContain('a.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters blank lines out of the output', () => {
    const root = initRepo();
    try {
      // No changes → diff emits nothing; result is an empty list, not [''].
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'init');
      const res = runGitLines(root, ['diff', '--name-only', 'HEAD']);
      expect(res.ok).toBe(true);
      expect(res.lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns ok:false with an error on a non-zero exit instead of throwing', () => {
    const root = initRepo();
    try {
      // A ref that does not resolve → rev-parse --verify --quiet exits 1.
      const res = runGitLines(root, ['rev-parse', '--verify', '--quiet', 'no-such-ref-xyz']);
      expect(res.ok).toBe(false);
      expect(res.lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns ok:false outside a git repository (never throws)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-git-lines-nongit-'));
    try {
      const res = runGitLines(root, ['rev-parse', '--is-inside-work-tree']);
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
