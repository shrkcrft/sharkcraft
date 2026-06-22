import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDelegateRecipe } from '@shrkcrft/config';
import { gatherRecipeContext } from '../commands/delegate.command.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-delegate-ctx-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), "export * from './alpha';\nexport * from './beta';\n");
  writeFileSync(join(root, 'src', 'other.ts'), 'export const helper = 1;\n');
  return root;
}

const recipe = (globs: string[]): IDelegateRecipe => ({
  id: 'add-barrel-export',
  guardrailGlobs: globs,
  allowedOps: ['export'],
  verificationIds: ['tsc'],
});

describe('gatherRecipeContext', () => {
  test('includes the in-scope file contents the worker may edit', () => {
    const root = project();
    try {
      const ctx = gatherRecipeContext(root, recipe(['src/**/index.ts']));
      expect(ctx).toContain('src/index.ts');
      expect(ctx).toContain("export * from './alpha';"); // the worker sees existing exports
      // A file outside the guardrail globs is NOT shown.
      expect(ctx).not.toContain('src/other.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns empty string when nothing is in scope', () => {
    const root = project();
    try {
      expect(gatherRecipeContext(root, recipe(['nonexistent/**']))).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
