/**
 * `.gitignore` safety helper.
 *
 * Verifies that `ensureSharkcraftGitignore`:
 *   - creates a new file when none exists;
 *   - appends only missing patterns (idempotent on a second call);
 *   - preserves arbitrary user content (comments, trailing slash quirks);
 *   - is dry-run safe (no write when `dryRun: true`);
 *   - never double-adds the managed block.
 */
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  ensureSharkcraftGitignore,
  SHARKCRAFT_GITIGNORE_PATTERNS,
} from '../init/gitignore.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-gitignore-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ensureSharkcraftGitignore', () => {
  test('creates .gitignore when missing (dry-run: no write)', () => {
    withTmp((dir) => {
      const patch = ensureSharkcraftGitignore({ cwd: dir, dryRun: true });
      expect(patch.created).toBe(true);
      expect(patch.added.length).toBe(SHARKCRAFT_GITIGNORE_PATTERNS.length);
      expect(patch.wrote).toBe(false);
      expect(existsSync(nodePath.join(dir, '.gitignore'))).toBe(false);
    });
  });

  test('creates .gitignore when missing (write)', () => {
    withTmp((dir) => {
      const patch = ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      expect(patch.wrote).toBe(true);
      const body = readFileSync(nodePath.join(dir, '.gitignore'), 'utf8');
      for (const p of SHARKCRAFT_GITIGNORE_PATTERNS) {
        expect(body).toContain(p);
      }
    });
  });

  test('idempotent: second call adds nothing', () => {
    withTmp((dir) => {
      const first = ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      const second = ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      expect(first.added.length).toBeGreaterThan(0);
      expect(second.added.length).toBe(0);
      expect(second.wrote).toBe(false);
      // No duplicate lines.
      const body = readFileSync(nodePath.join(dir, '.gitignore'), 'utf8');
      for (const p of SHARKCRAFT_GITIGNORE_PATTERNS) {
        const occurrences = body.split('\n').filter((l) => l.trim() === p).length;
        expect(occurrences).toBe(1);
      }
    });
  });

  test('preserves existing user content', () => {
    withTmp((dir) => {
      const giPath = nodePath.join(dir, '.gitignore');
      const userContent =
        'node_modules\ndist\n.DS_Store\n# important comment\nmy-secret.env\n';
      writeFileSync(giPath, userContent, 'utf8');
      ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      const after = readFileSync(giPath, 'utf8');
      // Existing user lines untouched.
      expect(after).toContain('node_modules');
      expect(after).toContain('dist');
      expect(after).toContain('.DS_Store');
      expect(after).toContain('# important comment');
      expect(after).toContain('my-secret.env');
      // Managed block appended.
      for (const p of SHARKCRAFT_GITIGNORE_PATTERNS) {
        expect(after).toContain(p);
      }
    });
  });

  test('partial-existing: only adds missing patterns', () => {
    withTmp((dir) => {
      const giPath = nodePath.join(dir, '.gitignore');
      // User already ignored some of our patterns; we add only the rest.
      writeFileSync(
        giPath,
        '.sharkcraft/sessions/\n.sharkcraft/reports/\n',
        'utf8',
      );
      const patch = ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      expect(patch.alreadyPresent).toContain('.sharkcraft/sessions/');
      expect(patch.alreadyPresent).toContain('.sharkcraft/reports/');
      expect(patch.added).not.toContain('.sharkcraft/sessions/');
      expect(patch.added).toContain('.sharkcraft/fixes/');
      // Total = stable across runs.
      const allPresent =
        patch.alreadyPresent.length + patch.added.length;
      expect(allPresent).toBe(SHARKCRAFT_GITIGNORE_PATTERNS.length);
    });
  });

  test('dry-run with existing file: computes patch, writes nothing', () => {
    withTmp((dir) => {
      const giPath = nodePath.join(dir, '.gitignore');
      writeFileSync(giPath, 'node_modules\n', 'utf8');
      const before = readFileSync(giPath, 'utf8');
      const patch = ensureSharkcraftGitignore({ cwd: dir, dryRun: true });
      const after = readFileSync(giPath, 'utf8');
      expect(after).toBe(before);
      expect(patch.added.length).toBeGreaterThan(0);
      expect(patch.wrote).toBe(false);
    });
  });

  test('never writes pattern twice even if user re-adds one between runs', () => {
    withTmp((dir) => {
      ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      const giPath = nodePath.join(dir, '.gitignore');
      // Simulate the user appending one of our patterns manually.
      writeFileSync(
        giPath,
        readFileSync(giPath, 'utf8') + '.sharkcraft/sessions/\n',
        'utf8',
      );
      ensureSharkcraftGitignore({ cwd: dir, dryRun: false });
      const body = readFileSync(giPath, 'utf8');
      const sessionsCount = body
        .split('\n')
        .filter((l) => l.trim() === '.sharkcraft/sessions/').length;
      expect(sessionsCount).toBe(2); // user line + managed line — but the next
      // pure ensure call would NOT add a third copy. The contract is: we
      // never *add* a duplicate; users' own duplicates are their own.
    });
  });
});
