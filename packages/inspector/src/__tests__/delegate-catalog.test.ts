import { describe, expect, test } from 'bun:test';
import { resolveDelegateCatalog, findDelegateRecipe } from '../delegate-catalog.ts';
import type { ISharkCraftConfig } from '@shrkcrft/config';

function cfg(over: Partial<ISharkCraftConfig['delegation']> & { recipes: NonNullable<ISharkCraftConfig['delegation']>['recipes'] }, verificationIds: string[] = ['barrel-tsc']): ISharkCraftConfig {
  return {
    verificationCommands: verificationIds.map((id) => ({ id, command: 'tsc' })),
    delegation: { enabled: true, ...over },
  };
}

const RECIPE = {
  id: 'add-barrel-export',
  guardrailGlobs: ['src/**/index.ts'],
  allowedOps: ['export'],
  verificationIds: ['barrel-tsc'],
};

describe('resolveDelegateCatalog', () => {
  test('applies the delegation-level provider default when a recipe omits it', () => {
    const cat = resolveDelegateCatalog(cfg({ provider: 'ollama', recipes: [RECIPE] }));
    expect(cat[0]?.resolvedProvider).toBe('ollama');
  });

  test('a recipe provider overrides the delegation default', () => {
    const cat = resolveDelegateCatalog(cfg({ provider: 'ollama', recipes: [{ ...RECIPE, provider: 'llamacpp' }] }));
    expect(cat[0]?.resolvedProvider).toBe('llamacpp');
  });

  test('marks a recipe delegatable when every verificationId is bound', () => {
    const cat = resolveDelegateCatalog(cfg({ recipes: [RECIPE] }));
    expect(cat[0]?.verificationBound).toBe(true);
    expect(cat[0]?.delegatable).toBe(true);
    expect(cat[0]?.unboundVerificationIds).toEqual([]);
  });

  test('flags an unbound verificationId — recipe is NOT delegatable', () => {
    const cat = resolveDelegateCatalog(cfg({ recipes: [{ ...RECIPE, verificationIds: ['ghost'] }] }));
    expect(cat[0]?.delegatable).toBe(false);
    expect(cat[0]?.unboundVerificationIds).toEqual(['ghost']);
  });

  test('a recipe with no verificationIds is NOT delegatable (no gate)', () => {
    const cat = resolveDelegateCatalog(cfg({ recipes: [{ ...RECIPE, verificationIds: [] }] }));
    expect(cat[0]?.delegatable).toBe(false);
    expect(cat[0]?.verificationBound).toBe(false);
  });

  test('no delegation block → empty catalog', () => {
    expect(resolveDelegateCatalog({ projectName: 'x' })).toEqual([]);
  });

  test('findDelegateRecipe looks one up by id', () => {
    expect(findDelegateRecipe(cfg({ recipes: [RECIPE] }), 'add-barrel-export')?.id).toBe('add-barrel-export');
    expect(findDelegateRecipe(cfg({ recipes: [RECIPE] }), 'nope')).toBeUndefined();
  });
});

describe('resolveDelegateCatalog — pack recipes + overrides', () => {
  const packRecipe = { id: 'pack-fix', guardrailGlobs: ['src/**'], allowedOps: ['replace'], verificationIds: ['barrel-tsc'] };

  test('merges a pack-contributed recipe with source + packageName', () => {
    const cat = resolveDelegateCatalog(cfg({ recipes: [] }), [{ recipe: packRecipe, packageName: '@acme/pack' }]);
    const found = cat.find((r) => r.id === 'pack-fix');
    expect(found?.source).toBe('pack');
    expect(found?.packageName).toBe('@acme/pack');
    expect(found?.delegatable).toBe(true);
  });

  test('an inline config recipe overrides a pack recipe of the same id', () => {
    const cat = resolveDelegateCatalog(
      cfg({ recipes: [{ ...packRecipe, allowedOps: ['export'] }] }),
      [{ recipe: packRecipe, packageName: '@acme/pack' }],
    );
    const found = cat.find((r) => r.id === 'pack-fix');
    expect(found?.source).toBe('config');
    expect(found?.allowedOps).toEqual(['export']);
  });

  test('recipeOverrides patch model + verificationIds, and can drop a recipe', () => {
    const base = cfg({ recipes: [RECIPE] });
    // Patch.
    const patched = resolveDelegateCatalog({
      ...base,
      delegation: { ...base.delegation, recipeOverrides: { 'add-barrel-export': { model: 'qwen', verificationIds: ['barrel-tsc'] } } },
    });
    expect(patched[0]?.resolvedModel).toBe('qwen');
    // Drop.
    const dropped = resolveDelegateCatalog({
      ...base,
      delegation: { ...base.delegation, recipeOverrides: { 'add-barrel-export': { enabled: false } } },
    });
    expect(dropped).toHaveLength(0);
  });

  test('an override pointing verificationIds at an unbound id makes the recipe non-delegatable', () => {
    const base = cfg({ recipes: [RECIPE] });
    const cat = resolveDelegateCatalog({
      ...base,
      delegation: { ...base.delegation, recipeOverrides: { 'add-barrel-export': { verificationIds: ['ghost'] } } },
    });
    expect(cat[0]?.delegatable).toBe(false);
    expect(cat[0]?.unboundVerificationIds).toEqual(['ghost']);
  });
});
