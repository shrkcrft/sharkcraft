/**
 * Load delegate-worker recipes contributed by discovered packs.
 *
 * A pack declares `contributions.delegateRecipeFiles[]`, each default-exporting
 * `readonly IDelegateRecipe[]` (via `defineDelegateRecipe`). This loads them
 * read-only (no model, no writes) so `resolveDelegateCatalog(config, packRecipes)`
 * can merge them with the project's inline recipes + `recipeOverrides`. Mirrors
 * the other pack registries (e.g. task-routing-hint-registry).
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { importModuleViaLoader, type IDelegateRecipe } from '@shrkcrft/core';
import type { ISharkCraftConfig } from '@shrkcrft/config';
import { discoverPacks, type IDiscoveredPack } from '@shrkcrft/packs';
import { resolveDelegateCatalog, type IResolvedDelegateRecipe } from './delegate-catalog.ts';

export interface IPackDelegateRecipe {
  recipe: IDelegateRecipe;
  packageName: string;
  /** The contributed file's relative path (for diagnostics). */
  sourceFile: string;
}

export interface IPackRecipeIssue {
  severity: 'warning' | 'error';
  message: string;
  source?: string;
}

export interface ILoadPackRecipesResult {
  recipes: readonly IPackDelegateRecipe[];
  issues: readonly IPackRecipeIssue[];
}

async function importRecipes(file: string): Promise<readonly IDelegateRecipe[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly IDelegateRecipe[] | IDelegateRecipe;
    delegateRecipes?: readonly IDelegateRecipe[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as IDelegateRecipe];
  if (Array.isArray(mod.delegateRecipes)) return mod.delegateRecipes;
  return [];
}

export async function loadDelegateRecipesFromPacks(
  validPacks: readonly IDiscoveredPack[],
): Promise<ILoadPackRecipesResult> {
  const recipes: IPackDelegateRecipe[] = [];
  const issues: IPackRecipeIssue[] = [];
  for (const pack of validPacks) {
    const files = pack.manifest?.contributions?.delegateRecipeFiles ?? [];
    for (const rel of files) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          message: `Pack ${pack.packageName} declares ${rel} but the file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importRecipes(file);
        for (const recipe of list) {
          recipes.push({ recipe, packageName: pack.packageName, sourceFile: rel });
        }
      } catch (e) {
        issues.push({
          severity: 'warning',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { recipes, issues };
}

/**
 * One-shot: discover packs under `projectRoot`, load their delegate recipes, and
 * resolve the full catalog (pack recipes + config recipes + `recipeOverrides`).
 * Pack discovery is best-effort — a missing/odd `node_modules` degrades to the
 * config-only catalog. Keeps `discoverPacks` inside `inspector` so the cli stays
 * decoupled from `@shrkcrft/packs`.
 */
export async function resolveDelegateCatalogForProject(
  config: ISharkCraftConfig,
  projectRoot: string,
): Promise<readonly IResolvedDelegateRecipe[]> {
  let packRecipes: { recipe: IDelegateRecipe; packageName: string }[] = [];
  try {
    const disc = await discoverPacks({ projectRoot });
    packRecipes = (await loadDelegateRecipesFromPacks(disc.validPacks)).recipes.map((p) => ({
      recipe: p.recipe,
      packageName: p.packageName,
    }));
  } catch {
    // best-effort; configured recipes still resolve
  }
  return resolveDelegateCatalog(config, packRecipes);
}
