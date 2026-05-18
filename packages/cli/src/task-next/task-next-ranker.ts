/**
 * `shrk task --next` ranker.
 *
 * Surveys the workspace, partitions findings by mechanical safety, and
 * proposes the single highest-leverage next action. Pure ranker over
 * existing JSON outputs — no new asset kinds, no AI, no domain logic
 * besides priority order.
 *
 * Ranking rules (deterministic, documented in dev-workflow.md):
 *   1. Doctor blockers (errors that fail-close release).
 *   2. Stale knowledge with `replaceWith` (mechanically safe --apply).
 *   3. Template drift `missing-barrel` (mechanically safe --apply).
 *   4. Action-hint stubs (mechanically safe --apply).
 *   5. Stale knowledge without `replaceWith` (needs --drop-stale).
 *   6. Template drift `forbidden-legacy-path` (needs human review).
 *   7. Everything else (preview-only).
 */
import type {
  IDoctorResult,
  IKnowledgeStaleReport,
  ITemplateDriftReport,
} from '@shrkcrft/inspector';

export const TASK_NEXT_SCHEMA = 'sharkcraft.task-next/v1';

export type NextActionKind = 'fix' | 'apply' | 'investigate';

export interface INextAction {
  readonly kind: NextActionKind;
  readonly command: string;
  readonly reason: string;
  /** How many blockers / findings this action resolves. */
  readonly resolves: number;
  /** True iff the action's --apply path is mechanically safe (no human review). */
  readonly autoApplyEligible: boolean;
}

export interface ITaskNextReport {
  readonly schema: typeof TASK_NEXT_SCHEMA;
  readonly generatedAt: string;
  readonly nextAction: INextAction | null;
  /** Up to 3 follow-on actions in descending priority order. */
  readonly secondary: readonly { command: string; reason: string }[];
  /** Quick totals so the agent can sanity-check the ranker. */
  readonly totals: {
    readonly doctorBlockers: number;
    readonly staleWithReplaceWith: number;
    readonly staleWithoutReplaceWith: number;
    readonly templateDriftMissingBarrel: number;
    readonly templateDriftForbiddenLegacyPath: number;
    readonly templateDriftOther: number;
    readonly knowledgeActionHintGaps: number;
  };
}

export interface ITaskNextInputs {
  readonly doctor: IDoctorResult;
  readonly stale: IKnowledgeStaleReport;
  readonly drift: ITemplateDriftReport;
  /**
   * Knowledge lint summary — used for the action-hint stubs leg. The
   * shape mirrors the `shrk lint --kind knowledge` JSON.
   */
  readonly knowledgeLint?: {
    readonly categories?: Readonly<Record<string, number>>;
  };
  /**
   * Spec status summary. The ranker picks the highest-leverage
   * unverified spec as a next action when no doctor blockers exist.
   * Pass-through `null` (or omit) when the workspace has no specs.
   */
  readonly specs?: {
    readonly implementingUnverified?: readonly { id: string; title: string }[];
  };
}

const BLOCKER_CATEGORIES = new Set([
  'config-invalid',
  'pack-signature-invalid',
  'plan-signature-divergent',
  'asset-load-failed',
  'config',
  'pack-doctor',
]);

/** Pure ranking over the structured inputs. */
export function buildTaskNextReport(inputs: ITaskNextInputs): ITaskNextReport {
  const { doctor, stale, drift, knowledgeLint, specs } = inputs;

  // 1. Doctor blockers — errors + warning-categories that gate release.
  // Mirrors `shrk doctor --blockers` semantics.
  const doctorBlockers = doctor.checks.filter(
    (c) =>
      c.severity === 'error' ||
      (c.severity === 'warning' && c.category !== undefined && BLOCKER_CATEGORIES.has(c.category)),
  ).length;

  // 2. Stale knowledge with replaceWith.
  const staleChecks = stale.referenceChecks.filter(
    (c) => c.outcome === 'stale' || c.outcome === 'missing',
  );
  const staleWithReplaceWith = staleChecks.filter((c) => c.replaceWith).length;
  const staleWithoutReplaceWith = staleChecks.length - staleWithReplaceWith;

  // 3 & 6. Template drift split by code.
  let templateDriftMissingBarrel = 0;
  let templateDriftForbiddenLegacyPath = 0;
  let templateDriftOther = 0;
  for (const e of drift.entries) {
    for (const i of e.issues) {
      if (i.severity !== 'error' && i.severity !== 'warning') continue;
      if (i.code === 'missing-barrel') templateDriftMissingBarrel += 1;
      else if (i.code === 'forbidden-legacy-path') templateDriftForbiddenLegacyPath += 1;
      else templateDriftOther += 1;
    }
  }

  // 4. Action-hint stubs from the knowledge lint.
  const cats = knowledgeLint?.categories ?? {};
  const knowledgeActionHintGaps = (cats['missing-action-hints'] ?? 0) + (cats['safe-mechanical-stub'] ?? 0);

  const totals = {
    doctorBlockers,
    staleWithReplaceWith,
    staleWithoutReplaceWith,
    templateDriftMissingBarrel,
    templateDriftForbiddenLegacyPath,
    templateDriftOther,
    knowledgeActionHintGaps,
  } as const;

  const secondary: { command: string; reason: string }[] = [];
  let nextAction: INextAction | null = null;

  // Priority 1 — doctor blockers.
  if (doctorBlockers > 0) {
    nextAction = {
      kind: 'fix',
      command: 'shrk doctor --blockers',
      reason: `${doctorBlockers} blocker(s) — release is gated until these clear.`,
      resolves: doctorBlockers,
      autoApplyEligible: false,
    };
  }

  // Priority 1.5: specs in `implementing` status that have NOT
  // passed `spec verify`. Surfaced after doctor blockers but before
  // stale-knowledge fixes — closing the spec loop is the highest-
  // leverage next step once blockers are clear.
  const implementingUnverified = specs?.implementingUnverified ?? [];
  if (!nextAction && implementingUnverified.length > 0) {
    const target = implementingUnverified[0]!;
    nextAction = {
      kind: 'investigate',
      command: `shrk spec verify ${target.id}`,
      reason: `Spec "${target.id}" is implementing but has no passing verification yet — close the loop.`,
      resolves: implementingUnverified.length,
      autoApplyEligible: false,
    };
  } else if (implementingUnverified.length > 0) {
    secondary.push({
      command: `shrk spec verify ${implementingUnverified[0]!.id}`,
      reason: `${implementingUnverified.length} spec(s) implementing without verification.`,
    });
  }

  // Priority 2 — stale knowledge with replaceWith.
  if (!nextAction && staleWithReplaceWith > 0) {
    nextAction = {
      kind: 'apply',
      command: 'shrk fix --knowledge-stale --apply',
      reason: `${staleWithReplaceWith} stale reference(s) have a replaceWith signal — apply renames in place.`,
      resolves: staleWithReplaceWith,
      autoApplyEligible: true,
    };
  } else if (staleWithReplaceWith > 0) {
    secondary.push({
      command: 'shrk fix --knowledge-stale --apply',
      reason: `${staleWithReplaceWith} stale reference(s) with replaceWith.`,
    });
  }

  // Priority 3 — template drift missing-barrel.
  if (!nextAction && templateDriftMissingBarrel > 0) {
    nextAction = {
      kind: 'apply',
      command: 'shrk fix --template-drift --apply',
      reason: `${templateDriftMissingBarrel} missing-barrel finding(s) — creates the file with a placeholder body.`,
      resolves: templateDriftMissingBarrel,
      autoApplyEligible: true,
    };
  } else if (templateDriftMissingBarrel > 0) {
    secondary.push({
      command: 'shrk fix --template-drift --apply',
      reason: `${templateDriftMissingBarrel} missing-barrel finding(s).`,
    });
  }

  // Priority 4 — action-hint stubs.
  if (!nextAction && knowledgeActionHintGaps > 0) {
    nextAction = {
      kind: 'apply',
      command: 'shrk fix --action-hints --apply',
      reason: `${knowledgeActionHintGaps} knowledge entr(y/ies) missing action hints — stubs are mechanically safe.`,
      resolves: knowledgeActionHintGaps,
      autoApplyEligible: true,
    };
  } else if (knowledgeActionHintGaps > 0) {
    secondary.push({
      command: 'shrk fix --action-hints --apply',
      reason: `${knowledgeActionHintGaps} action-hint stub(s).`,
    });
  }

  // Priority 5 — stale knowledge without replaceWith.
  if (!nextAction && staleWithoutReplaceWith > 0) {
    nextAction = {
      kind: 'investigate',
      command: 'shrk knowledge stale-check --ci',
      reason: `${staleWithoutReplaceWith} stale reference(s) without an unambiguous rename — review then re-run with --drop-stale.`,
      resolves: staleWithoutReplaceWith,
      autoApplyEligible: false,
    };
  } else if (staleWithoutReplaceWith > 0) {
    secondary.push({
      command: 'shrk knowledge stale-check --ci',
      reason: `${staleWithoutReplaceWith} stale reference(s) need human review.`,
    });
  }

  // Priority 6 — template drift forbidden-legacy-path.
  if (!nextAction && templateDriftForbiddenLegacyPath > 0) {
    nextAction = {
      kind: 'investigate',
      command: 'shrk templates drift --min-severity warning',
      reason: `${templateDriftForbiddenLegacyPath} forbidden-legacy-path finding(s) — needs human decision on convention.`,
      resolves: templateDriftForbiddenLegacyPath,
      autoApplyEligible: false,
    };
  } else if (templateDriftForbiddenLegacyPath > 0) {
    secondary.push({
      command: 'shrk templates drift --min-severity warning',
      reason: `${templateDriftForbiddenLegacyPath} forbidden-legacy-path finding(s).`,
    });
  }

  // Priority 7 — everything else.
  if (!nextAction && templateDriftOther > 0) {
    nextAction = {
      kind: 'investigate',
      command: 'shrk templates drift --min-severity warning',
      reason: `${templateDriftOther} other template-drift finding(s) — preview-only.`,
      resolves: templateDriftOther,
      autoApplyEligible: false,
    };
  }

  return {
    schema: TASK_NEXT_SCHEMA,
    generatedAt: new Date().toISOString(),
    nextAction,
    secondary: secondary.slice(0, 3),
    totals,
  };
}
