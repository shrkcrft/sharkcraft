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
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IDelegateRecipe,
  type IRejectedEntry,
} from '@shrkcrft/core';
import { DelegateRecipeSchema, type ISharkCraftConfig } from '@shrkcrft/config';
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
  /** `load-failed` / `missing-file` — lifted into THE contribution load-failure map (round 12). */
  code?: 'load-failed' | 'missing-file';
}

export interface ILoadPackRecipesResult {
  recipes: readonly IPackDelegateRecipe[];
  issues: readonly IPackRecipeIssue[];
  /** Every declared recipe the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}

/**
 * THE pack delegate-recipe acceptance predicate (round 12, 12.1): the SAME
 * zod schema the config loader validates an inline recipe with
 * (`DelegateRecipeSchema`), one `<path>: <message>` per issue — `[]` means
 * accepted. A pack recipe used to be accepted with no validation at all.
 */
export function delegateRecipeRejectionReasons(raw: unknown): readonly string[] {
  const parsed = DelegateRecipeSchema.safeParse(raw);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`);
}

export async function loadDelegateRecipesFromPacks(
  validPacks: readonly IDiscoveredPack[],
): Promise<ILoadPackRecipesResult> {
  const recipes: IPackDelegateRecipe[] = [];
  const issues: IPackRecipeIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();
  for (const pack of validPacks) {
    const files = pack.manifest?.contributions?.delegateRecipeFiles ?? [];
    for (const rel of files) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares ${rel} but the file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const exp = readContributionExport(await importModuleViaLoader(file), { namedKeys: ['delegateRecipes'] });
        exp.items.forEach((raw, i) => {
          const at = {
            file,
            index: exp.single ? -1 : i,
            ...(exp.exportName ? { exportName: exp.exportName } : {}),
          };
          const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
          const id = typeof rawId === 'string' ? rawId : undefined;
          const reasons = delegateRecipeRejectionReasons(raw);
          if (reasons.length > 0) {
            rejected.push({ ...at, ...(id ? { entryId: id } : {}), reasons, cause: RejectionCause.Invalid });
            return;
          }
          const recipe = raw as IDelegateRecipe;
          const prev = seen.get(recipe.id);
          if (prev !== undefined) {
            rejected.push({
              ...at,
              entryId: recipe.id,
              reasons: [`id: "${recipe.id}" is already declared in ${prev}`],
              cause: RejectionCause.DuplicateId,
            });
            return;
          }
          seen.set(recipe.id, `${pack.packageName} (${rel})`);
          recipes.push({ recipe, packageName: pack.packageName, sourceFile: rel });
        });
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { recipes, issues, rejected };
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
