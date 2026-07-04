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
import { DELEGATE_QUERY_IDS, type ISharkCraftConfig } from '@shrkcrft/config';
import { DoctorSeverity, type IDoctorCheck } from './doctor-result.ts';
import { resolveDelegateCatalog } from './delegate-catalog.ts';

export function buildDelegateRecipeChecks(config: ISharkCraftConfig | null): IDoctorCheck[] {
  if (!config?.delegation) return []; // not opted in → silent
  const catalog = resolveDelegateCatalog(config);
  if (catalog.length === 0) return [];
  const out: IDoctorCheck[] = [];
  const broken = catalog.filter((r) => !r.delegatable);
  for (const r of broken) {
    const isAnalysis = r.mode === 'analysis';
    const reason = isAnalysis
      ? `groundedOn "${r.groundedOn ?? '(unset)'}" is not a known grounding report`
      : r.unboundVerificationIds.length > 0
        ? `verificationIds not in verificationCommands[]: ${r.unboundVerificationIds.join(', ')}`
        : 'no verificationIds declared';
    const consequence = isAnalysis
      ? `\`shrk delegate analyze --recipe ${r.id}\` has no deterministic ground truth to check the model against.`
      : `\`shrk delegate run --recipe ${r.id}\` would refuse to apply an unverified edit.`;
    out.push({
      id: `delegate-recipe-${r.id}`,
      title: `Delegate recipe "${r.id}" is not ${isAnalysis ? 'usable' : 'delegatable'}`,
      severity: DoctorSeverity.Warning,
      message: `${reason} — ${consequence}`,
      category: 'delegate',
      code: isAnalysis ? 'recipe-ungrounded' : 'recipe-unverified',
      recommendedFix: `shrk delegate explain ${r.id}`,
      whyThisMatters: isAnalysis
        ? 'An analysis recipe grounds the model on a deterministic report; without a known groundedOn there is no ground truth to cross-check findings against, so the recipe is unusable.'
        : 'A recipe with an unbound verification has no deterministic gate; the worker can only run a VERIFIED edit, so the recipe is unusable until its verificationIds bind to a verificationCommands[] entry.',
    });
  }
  // Analysis-recipe config health beyond grounding (validateConfig isn't run at
  // load, so these would otherwise silently misbehave): unknown query ids and an
  // escalateTo that doesn't resolve to a patch recipe.
  const patchIds = new Set(catalog.filter((r) => r.mode !== 'analysis').map((r) => r.id));
  for (const r of catalog) {
    if (r.mode !== 'analysis') continue;
    const badQueries = (r.allowedQueries ?? []).filter((q) => !(DELEGATE_QUERY_IDS as readonly string[]).includes(q));
    if (badQueries.length > 0) {
      out.push({
        id: `delegate-recipe-${r.id}-queries`,
        title: `Delegate recipe "${r.id}" has unknown allowedQueries`,
        severity: DoctorSeverity.Warning,
        message: `${badQueries.join(', ')} — not in DELEGATE_QUERY_IDS (${DELEGATE_QUERY_IDS.join(', ')}); the model can never call them.`,
        category: 'delegate',
        code: 'recipe-unknown-query',
        recommendedFix: `shrk delegate explain ${r.id}`,
      });
    }
    if (r.escalateTo !== undefined && !patchIds.has(r.escalateTo)) {
      out.push({
        id: `delegate-recipe-${r.id}-escalate`,
        title: `Delegate recipe "${r.id}" escalates to a non-patch recipe`,
        severity: DoctorSeverity.Warning,
        message: `escalateTo "${r.escalateTo}" is not an existing patch recipe — \`--escalate\` would be a no-op.`,
        category: 'delegate',
        code: 'recipe-bad-escalation',
        recommendedFix: `shrk delegate explain ${r.id}`,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      id: 'delegate-recipes',
      title: 'Delegate recipes',
      severity: DoctorSeverity.Ok,
      message: `${catalog.length} delegate recipe(s) configured, all healthy.`,
      category: 'delegate',
    });
  }
  return out;
}
