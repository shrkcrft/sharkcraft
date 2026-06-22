import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ccrDir } from '../output/ccr-store-config.ts';

describe('ccrDir (project-root walk-up)', () => {
  test('resolves to the nearest ancestor .sharkcraft from any subdir', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ccr-'));
    try {
      mkdirSync(join(root, '.sharkcraft'), { recursive: true });
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      const expected = join(root, '.sharkcraft', 'ccr');
      // From the root AND from a deep subdir, the CCR cache is the SAME dir —
      // so a marker compressed at the root is recoverable via `expand` from a
      // subdir instead of being a silent miss.
      expect(ccrDir(root)).toBe(expected);
      expect(ccrDir(join(root, 'a', 'b'))).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to cwd when no project root exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-ccr-none-'));
    try {
      expect(ccrDir(root)).toBe(join(root, '.sharkcraft', 'ccr'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
