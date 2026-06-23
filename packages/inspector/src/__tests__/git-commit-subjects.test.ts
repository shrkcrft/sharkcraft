/**
 * getCommitSubjects — the git helper that lets `knowledge propose --since <ref>`
 * annotate each draft with the commit that surfaced it. Runs git in an isolated
 * temp repo (never the project repo).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCommitSubjects } from '../git-helpers.ts';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('getCommitSubjects', () => {
  test('returns [] outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-nogit-'));
    try {
      expect(getCommitSubjects(dir, { since: 'HEAD' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses subject + touched files for commits in <since>..HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-git-'));
    try {
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 'test@example.com');
      git(dir, 'config', 'user.name', 'Test');
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      git(dir, 'add', 'a.ts');
      git(dir, 'commit', '-q', '-m', 'baseline commit');
      git(dir, 'tag', 'base');

      writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
      git(dir, 'add', 'b.ts');
      git(dir, 'commit', '-q', '-m', 'add the b feature');

      const commits = getCommitSubjects(dir, { since: 'base' });
      expect(commits.length).toBe(1);
      expect(commits[0]?.subject).toBe('add the b feature');
      expect(commits[0]?.files).toContain('b.ts');
      expect(commits[0]?.shortHash.length).toBe(8);

      // Empty range yields nothing (the default HEAD..HEAD case).
      expect(getCommitSubjects(dir, { since: 'HEAD' })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
