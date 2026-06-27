import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChangesSummary } from '../changes-summary.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { getChangedFiles } from '../git-helpers.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-changes-untracked-'));
  git(root, 'init');
  git(root, 'config', 'user.email', 't@t.t');
  git(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'tracked.md'), 'base\n');
  git(root, 'add', 'tracked.md');
  git(root, 'commit', '-m', 'init');
  // A tracked modification …
  writeFileSync(join(root, 'tracked.md'), 'base\nchanged\n');
  // … plus an UNTRACKED directory with two files …
  mkdirSync(join(root, 'architecture'), { recursive: true });
  writeFileSync(join(root, 'architecture', 'a.md'), 'a\n');
  writeFileSync(join(root, 'architecture', 'b.md'), 'b\n');
  // … plus a gitignored file that must NOT be counted.
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  writeFileSync(join(root, 'skip.log'), 'ignored\n');
  return root;
}

describe('changes summary — untracked files', () => {
  test('getChangedFiles({includeWorktree}) lists untracked files individually, honoring .gitignore', () => {
    const root = setupRepo();
    try {
      const files = getChangedFiles(root, { includeWorktree: true });
      expect(files).toContain('architecture/a.md');
      expect(files).toContain('architecture/b.md');
      expect(files).toContain('tracked.md');
      // Untracked dir is NOT collapsed to a single `architecture/` entry.
      expect(files).not.toContain('architecture/');
      // Gitignored file excluded.
      expect(files).not.toContain('skip.log');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('buildChangesSummary includes untracked files and classifies .md as docs', async () => {
    const root = setupRepo();
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildChangesSummary(inspection, {});
      // tracked mod + 2 untracked .md + .gitignore = 4 (skip.log excluded).
      expect(report.totalFiles).toBe(4);
      const paths = report.files.map((f) => f.path);
      expect(paths).toContain('architecture/a.md');
      expect(paths).toContain('architecture/b.md');
      expect(paths).not.toContain('skip.log');
      // The architecture markdown classifies as docs, not unknown.
      const docs = report.filesByArea['docs'] ?? [];
      expect(docs).toContain('architecture/a.md');
      expect(docs).toContain('architecture/b.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
