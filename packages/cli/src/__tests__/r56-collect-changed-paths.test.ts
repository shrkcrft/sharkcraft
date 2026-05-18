/**
 * collectChangedPaths: thin shell over `git diff --name-status
 * <ref>`. Behavior locked: returns isAvailable=false in non-git
 * dirs, falls back through the candidate ref list, never throws.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { collectChangedPaths, resolveDefaultSinceRef } from '../diff/collect-changed-paths.ts';

function makeInitialisedRepo(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r56-diff-'));
  // Initialise a tiny git repo with a single commit so HEAD exists.
  // Keeps the test independent of whatever state process.cwd() is in
  // (a freshly-init'd workspace with no commits yet would otherwise
  // fail the HEAD probe).
  const opts = { cwd: dir, encoding: 'utf8' as const };
  spawnSync('git', ['init', '-q', '-b', 'main'], opts);
  spawnSync('git', ['config', 'user.email', 'test@example.com'], opts);
  spawnSync('git', ['config', 'user.name', 'test'], opts);
  spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], opts);
  return dir;
}

describe('collectChangedPaths', () => {
  test('non-git directory returns isAvailable=false', () => {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r56-diff-'));
    try {
      const r = collectChangedPaths({ cwd: dir });
      expect(r.isAvailable).toBe(false);
      expect(r.changed.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveDefaultSinceRef returns undefined in non-git dir', () => {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r56-diff-'));
    try {
      const ref = resolveDefaultSinceRef(dir);
      expect(ref).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns isAvailable=true in a git repo with HEAD', () => {
    // Create a fresh repo with at least one commit so the assertion
    // doesn't depend on process.cwd() having a HEAD.
    const dir = makeInitialisedRepo();
    try {
      const r = collectChangedPaths({ cwd: dir, ref: 'HEAD' });
      expect(r.isAvailable).toBe(true);
      // `git diff HEAD` may have 0..N changes depending on the workspace.
      expect(r.changed.length).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
