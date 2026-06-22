/**
 * Pack-authoring helper for delegate-worker recipes. A pack ships recipes via
 * `contributions.delegateRecipeFiles`, each file `export default` an array:
 *
 *   import { defineDelegateRecipe } from '@shrkcrft/plugin-api';
 *   export default [
 *     defineDelegateRecipe({
 *       id: 'add-barrel-export',
 *       guardrailGlobs: ['src/**\/index.ts'],
 *       allowedOps: ['export'],
 *       verificationIds: ['barrel-tsc'],
 *     }),
 *   ];
 *
 * The recipe contract itself lives in `@shrkcrft/core` (shared with the config
 * loader); this only re-exports it + the identity define-helper, mirroring
 * `definePackPolicyCheck`.
 */
import type { IDelegateRecipe } from '@shrkcrft/core';

export type { IDelegateRecipe, IDelegateRecipeMatch } from '@shrkcrft/core';

/** Identity helper that gives pack authors editor type-checking on a recipe. */
export function defineDelegateRecipe(recipe: IDelegateRecipe): IDelegateRecipe {
  return recipe;
}
