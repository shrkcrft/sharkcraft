/**
 * Missing-barrel auto-create.
 *
 *   - Creates the missing file with a placeholder `export {};` body.
 *   - Refuses pack targets (`node_modules/` or `dist/`).
 *   - Refuses path-escape.
 *   - Idempotent — refuses when the file already exists.
 *   - Creates intermediate directories.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { applyMissingBarrelFix } from '../asset-preview/apply-missing-barrel.ts';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r54-barrel-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('applyMissingBarrelFix', () => {
  test('creates the missing barrel with placeholder body', () => {
    withTmp((dir) => {
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: 'packages/feature/src/index.ts',
        write: true,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(true);
      const abs = nodePath.join(dir, 'packages/feature/src/index.ts');
      expect(existsSync(abs)).toBe(true);
      const body = readFileSync(abs, 'utf8');
      expect(body).toContain('export {};');
      expect(body).toContain('AUTO-CREATED');
    });
  });

  test('preview (write=false) does not create the file', () => {
    withTmp((dir) => {
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: 'packages/feature/src/index.ts',
        write: false,
      });
      expect(result.ok).toBe(true);
      expect(result.wrote).toBe(false);
      const abs = nodePath.join(dir, 'packages/feature/src/index.ts');
      expect(existsSync(abs)).toBe(false);
    });
  });

  test('refuses when the file already exists (idempotent)', () => {
    withTmp((dir) => {
      const abs = nodePath.join(dir, 'packages/feature/src/index.ts');
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, '// existing content\n', 'utf8');
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: 'packages/feature/src/index.ts',
        write: true,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/already exists/);
      // Existing content preserved.
      expect(readFileSync(abs, 'utf8')).toBe('// existing content\n');
    });
  });

  test('refuses path-escape on barrel target', () => {
    withTmp((dir) => {
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: '../escape.ts',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/escape/);
    });
  });

  test('refuses node_modules target', () => {
    withTmp((dir) => {
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: 'node_modules/@demo/pack/src/index.ts',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/pack \/ build artifact/);
    });
  });

  test('refuses dist target', () => {
    withTmp((dir) => {
      const result = applyMissingBarrelFix({
        cwd: dir,
        barrelPath: 'packages/feature/dist/index.ts',
        write: false,
      });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatch(/pack \/ build artifact/);
    });
  });
});
