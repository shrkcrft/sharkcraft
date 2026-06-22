import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePackManifest } from '@shrkcrft/plugin-api';
import type { IDiscoveredPack } from '@shrkcrft/packs';
import { loadDelegateRecipesFromPacks } from '../delegate-pack-recipes.ts';

function packWith(recipeFile: string | null): { pack: IDiscoveredPack; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-pack-recipe-'));
  if (recipeFile !== null) {
    writeFileSync(join(root, 'recipes.ts'), recipeFile);
  }
  const pack = {
    packageName: '@acme/delegate-pack',
    packageRoot: root,
    manifest: { contributions: { delegateRecipeFiles: ['recipes.ts'] } },
  } as unknown as IDiscoveredPack;
  return { pack, root };
}

describe('loadDelegateRecipesFromPacks', () => {
  test('loads recipes default-exported from a pack delegateRecipeFile', async () => {
    const { pack, root } = packWith(
      "export default [{ id: 'pack-rename', guardrailGlobs: ['src/**'], allowedOps: ['replace'], verificationIds: ['tsc'] }];\n",
    );
    try {
      const { recipes, issues } = await loadDelegateRecipesFromPacks([pack]);
      expect(issues).toHaveLength(0);
      expect(recipes).toHaveLength(1);
      expect(recipes[0]?.recipe.id).toBe('pack-rename');
      expect(recipes[0]?.packageName).toBe('@acme/delegate-pack');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('warns (does not throw) when a declared recipe file is missing', async () => {
    const { pack, root } = packWith(null);
    try {
      const { recipes, issues } = await loadDelegateRecipesFromPacks([pack]);
      expect(recipes).toHaveLength(0);
      expect(issues.some((i) => i.severity === 'warning' && i.message.includes('missing'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('validatePackManifest — delegateRecipeFiles', () => {
  const base = { schema: 'sharkcraft.pack/v1', info: { name: 'x', version: '1.0.0' } };

  test('accepts delegateRecipeFiles as an array of strings', () => {
    const r = validatePackManifest({ ...base, contributions: { delegateRecipeFiles: ['recipes.ts'] } });
    expect(r.valid).toBe(true);
  });

  test('rejects a non-array delegateRecipeFiles', () => {
    const r = validatePackManifest({ ...base, contributions: { delegateRecipeFiles: 'recipes.ts' } });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field.includes('delegateRecipeFiles'))).toBe(true);
  });
});
