import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFolderOps } from '../folder-apply.ts';

describe('applyFolderOps rename destination safety', () => {
  test('rejects a rename-folder whose newPath escapes the project root (folder not moved)', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-folder-safety-'));
    try {
      mkdirSync(join(root, 'src'));
      const escaped = join(root, '..', 'shrk-escaped-target');
      const report = applyFolderOps(
        [{ kind: 'rename-folder', targetPath: 'src', newPath: '../shrk-escaped-target' }],
        { projectRoot: root, dryRun: false, allowFolderOps: true },
      );
      expect(report.applied.length).toBe(0);
      expect(report.rejected.length).toBe(1);
      expect(report.rejected[0]!.reason).toContain('outside the project root');
      // The folder must still be in place, and nothing created outside the root.
      expect(existsSync(join(root, 'src'))).toBe(true);
      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('still allows a safe in-root rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-folder-safety-'));
    try {
      mkdirSync(join(root, 'src'));
      const report = applyFolderOps(
        [{ kind: 'rename-folder', targetPath: 'src', newPath: 'lib' }],
        { projectRoot: root, dryRun: false, allowFolderOps: true },
      );
      expect(report.applied.length).toBe(1);
      expect(report.applied[0]!.applied).toBe(true);
      expect(existsSync(join(root, 'lib'))).toBe(true);
      expect(existsSync(join(root, 'src'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
