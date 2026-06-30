import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeResolveTargetPath,
  UnsafeTargetPathError,
} from '@shrkcrft/core';
import { checkFolderOpSafety, FolderOpSafety } from '../folder-safety.ts';

/**
 * G3-2 (HIGH — destructive sandbox escape): delete-folder / rename-folder and
 * generator file writes must NOT follow an in-root symlink out of the project
 * root. checkFolderOpSafety / safeResolveTargetPath were purely lexical, so
 * `root/linkdir -> ../outside` made `linkdir/secret` look contained while it
 * physically lives outside the sandbox — a recursive delete on it would
 * corrupt EXTERNAL data and report success.
 */
describe('checkFolderOpSafety realpath containment (symlink escape)', () => {
  test('rejects delete-folder that escapes the root through an in-root symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-symlink-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'shrk-symlink-outside-'));
    try {
      mkdirSync(join(outside, 'secret'));
      symlinkSync(outside, join(root, 'linkdir'), 'dir');

      const result = checkFolderOpSafety(
        root,
        'linkdir/secret',
        'delete-folder',
        { allowDeleteFolder: true },
      );
      expect(result.safety).toBe(FolderOpSafety.Unsafe);
      expect(result.reason ?? '').toContain('outside the project root');
      // The external data must still be present — proving nothing was deleted.
      expect(existsSync(join(outside, 'secret'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects rename-folder whose SOURCE escapes the root through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-symlink-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'shrk-symlink-outside-'));
    try {
      mkdirSync(join(outside, 'secret'));
      symlinkSync(outside, join(root, 'linkdir'), 'dir');

      const result = checkFolderOpSafety(root, 'linkdir/secret', 'rename-folder');
      expect(result.safety).toBe(FolderOpSafety.Unsafe);
      expect(result.reason ?? '').toContain('outside the project root');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('still returns Safe for a plain in-root directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-symlink-root-'));
    try {
      mkdirSync(join(root, 'realdir'));
      const result = checkFolderOpSafety(root, 'realdir', 'rename-folder');
      expect(result.safety).toBe(FolderOpSafety.Safe);
      expect(result.reason).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('safeResolveTargetPath realpath containment (symlink escape)', () => {
  test('refuses a write that traverses an in-root symlink out of the sandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-symlink-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'shrk-symlink-outside-'));
    try {
      symlinkSync(outside, join(root, 'linkdir'), 'dir');

      expect(() => safeResolveTargetPath('linkdir/x.ts', root)).toThrow(
        UnsafeTargetPathError,
      );
      try {
        safeResolveTargetPath('linkdir/x.ts', root);
      } catch (e) {
        expect((e as UnsafeTargetPathError).code).toBe('outside-project-root');
        expect((e as Error).message).toContain('symlink escape');
      }
      // Nothing was created outside the sandbox.
      expect(existsSync(join(outside, 'x.ts'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('still resolves a plain in-root write', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-symlink-root-'));
    try {
      const result = safeResolveTargetPath('src/services/user.service.ts', root);
      expect(result.relativePath).toBe('src/services/user.service.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
