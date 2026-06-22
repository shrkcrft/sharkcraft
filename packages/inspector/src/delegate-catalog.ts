/**
 * Resolve the delegate-recipe catalog from a loaded config (read-only, NO model).
 *
 * Merges the delegation-level `provider`/`model` defaults into each recipe and
 * checks every `verificationId` against the config's `verificationCommands[]`.
 * A recipe is `delegatable` only when ALL its verification ids are bound — a
 * recipe with an unbound (or empty) verification has no deterministic gate, so
 * `shrk delegate explain` can show an author the fence is real before trusting
 * it. Pack-contributed recipes (Phase 4) will merge in here too.
 */
import type { IDelegateRecipe, ISharkCraftConfig } from '@shrkcrft/config';

export interface IResolvedDelegateRecipe extends IDelegateRecipe {
  /** Provider after applying the delegation-level default (never undefined). */
  resolvedProvider: 'auto' | 'ollama' | 'llamacpp';
  /** Model after applying the delegation-level default (undefined = provider default). */
  resolvedModel?: string;
  /** verificationIds that do NOT resolve to a `verificationCommands[].id`. */
  unboundVerificationIds: readonly string[];
  /** True when every verificationId resolves AND at least one is declared. */
  verificationBound: boolean;
  /** True when the recipe is safe to delegate (verification fully bound). */
  delegatable: boolean;
  /** Where the recipe came from. */
  source: 'config' | 'pack';
  /** Contributing pack, when `source === 'pack'`. */
  packageName?: string;
}

/** A pack-contributed recipe (shape from `loadDelegateRecipesFromPacks`). */
export interface IPackRecipeInput {
  recipe: IDelegateRecipe;
  packageName: string;
}

/**
 * Resolve the delegate catalog from config + pack-contributed recipes.
 *
 * Merge order: pack recipes first, then INLINE config recipes override a pack
 * recipe of the same id. `recipeOverrides` (by id) then patch model /
 * verificationIds / guardrailGlobs, or drop the recipe (`enabled: false`).
 * Finally each recipe's `verificationIds` are checked against
 * `verificationCommands[]` — `delegatable` only when all are bound.
 */
export function resolveDelegateCatalog(
  config: ISharkCraftConfig,
  packRecipes: readonly IPackRecipeInput[] = [],
): readonly IResolvedDelegateRecipe[] {
  const delegation = config.delegation;
  if (!delegation) return [];
  const known = new Set((config.verificationCommands ?? []).map((v) => v.id));
  const overrides = delegation.recipeOverrides ?? {};

  const byId = new Map<string, { recipe: IDelegateRecipe; source: 'config' | 'pack'; packageName?: string }>();
  for (const pr of packRecipes) byId.set(pr.recipe.id, { recipe: pr.recipe, source: 'pack', packageName: pr.packageName });
  for (const recipe of delegation.recipes ?? []) byId.set(recipe.id, { recipe, source: 'config' });

  const out: IResolvedDelegateRecipe[] = [];
  for (const { recipe, source, packageName } of byId.values()) {
    const ov = overrides[recipe.id];
    if (ov?.enabled === false) continue; // dropped by override
    const merged: IDelegateRecipe = {
      ...recipe,
      ...(ov?.model !== undefined ? { model: ov.model } : {}),
      ...(ov?.verificationIds !== undefined ? { verificationIds: ov.verificationIds } : {}),
      ...(ov?.guardrailGlobs !== undefined ? { guardrailGlobs: ov.guardrailGlobs } : {}),
    };
    const unbound = (merged.verificationIds ?? []).filter((id) => !known.has(id));
    const verificationBound = unbound.length === 0 && (merged.verificationIds ?? []).length > 0;
    out.push({
      ...merged,
      resolvedProvider: merged.provider ?? delegation.provider ?? 'auto',
      ...(merged.model ?? delegation.model ? { resolvedModel: merged.model ?? delegation.model } : {}),
      unboundVerificationIds: unbound,
      verificationBound,
      delegatable: verificationBound,
      source,
      ...(packageName ? { packageName } : {}),
    });
  }
  return out;
}

/** Look up one resolved recipe by id (config recipes only; no pack loading). */
export function findDelegateRecipe(
  config: ISharkCraftConfig,
  recipeId: string,
): IResolvedDelegateRecipe | undefined {
  return resolveDelegateCatalog(config).find((r) => r.id === recipeId);
}
