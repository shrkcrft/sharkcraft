import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { getChangedFiles, getStatusSummary, isGitRepo } from '../index.ts';

describe('git helpers', () => {
  it('reports non-git dirs cleanly', () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-git-'));
    try {
      writeFileSync(nodePath.join(root, 'a.txt'), 'x');
      expect(isGitRepo(root)).toBe(false);
      expect(getChangedFiles(root)).toEqual([]);
      const s = getStatusSummary(root);
      expect(s.clean).toBe(true);
      expect(s.branch).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
