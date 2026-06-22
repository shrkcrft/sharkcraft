/**
 * `shrk doctor` checks for delegate-worker recipe health.
 *
 * Surfaces recipes that are NOT delegatable — a recipe whose `verificationIds`
 * don't all resolve to `verificationCommands[]` (incl. after `recipeOverrides`)
 * has no deterministic gate, so `shrk delegate run` would refuse it. `runDoctor`
 * has no other surface for this (it doesn't run `validateConfig`), so this is the
 * proactive catch. Sync + config-only (pack-recipe health is `delegate explain`,
 * which can load pack files async); silent when the repo hasn't opted into
 * delegation.
 */
import type { ISharkCraftConfig } from '@shrkcrft/config';
import { DoctorSeverity, type IDoctorCheck } from './doctor-result.ts';
import { resolveDelegateCatalog } from './delegate-catalog.ts';

export function buildDelegateRecipeChecks(config: ISharkCraftConfig | null): IDoctorCheck[] {
  if (!config?.delegation) return []; // not opted in → silent
  const catalog = resolveDelegateCatalog(config);
  if (catalog.length === 0) return [];
  const out: IDoctorCheck[] = [];
  const broken = catalog.filter((r) => !r.delegatable);
  for (const r of broken) {
    const reason =
      r.unboundVerificationIds.length > 0
        ? `verificationIds not in verificationCommands[]: ${r.unboundVerificationIds.join(', ')}`
        : 'no verificationIds declared';
    out.push({
      id: `delegate-recipe-${r.id}`,
      title: `Delegate recipe "${r.id}" is not delegatable`,
      severity: DoctorSeverity.Warning,
      message: `${reason} — \`shrk delegate run --recipe ${r.id}\` would refuse to apply an unverified edit.`,
      category: 'delegate',
      code: 'recipe-unverified',
      recommendedFix: `shrk delegate explain ${r.id}`,
      whyThisMatters:
        'A recipe with an unbound verification has no deterministic gate; the worker can only run a VERIFIED edit, so the recipe is unusable until its verificationIds bind to a verificationCommands[] entry.',
    });
  }
  if (broken.length === 0) {
    out.push({
      id: 'delegate-recipes',
      title: 'Delegate recipes',
      severity: DoctorSeverity.Ok,
      message: `${catalog.length} delegate recipe(s) configured, all delegatable.`,
      category: 'delegate',
    });
  }
  return out;
}
