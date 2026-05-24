import { planRewrite, type IRewritePlan } from '@shrkcrft/structural-search';
import type { IMigration, MigrationStep } from '../schema/migration.ts';

export interface IPlannedStep {
  index: number;
  id: string;
  description?: string;
  step: MigrationStep;
  /** For structural-rewrite steps, the computed plan (dry). */
  rewritePlan?: IRewritePlan;
}

export interface IMigrationPlan {
  schema: 'sharkcraft.migration-plan/v1';
  migration: { id: string; title: string };
  plannedSteps: readonly IPlannedStep[];
  /** Sum of (rewritePlan.totalEdits) across all rewrite steps. */
  totalEdits: number;
  /** Sum of (rewritePlan.files.length) across all rewrite steps. */
  totalFiles: number;
}

/**
 * Compute the migration's plan without writing anything.
 *
 * `structural-rewrite` steps are pre-computed via `planRewrite` so the
 * caller can preview file-level edits before deciding to apply.
 * `shell` / `check` steps are listed as-is — they're executed only
 * during `applyMigration`.
 */
export function planMigration(migration: IMigration, projectRoot: string): IMigrationPlan {
  const plannedSteps: IPlannedStep[] = [];
  let totalEdits = 0;
  let totalFiles = 0;
  for (let i = 0; i < migration.steps.length; i += 1) {
    const step = migration.steps[i]!;
    const id = step.id ?? `step-${i + 1}`;
    if (step.kind === 'structural-rewrite') {
      const rewritePlan = planRewrite({
        projectRoot,
        pattern: step.pattern,
        recipe: step.recipe,
      });
      totalEdits += rewritePlan.totalEdits;
      totalFiles += rewritePlan.files.length;
      plannedSteps.push({
        index: i,
        id,
        ...(step.description ? { description: step.description } : {}),
        step,
        rewritePlan,
      });
    } else {
      plannedSteps.push({
        index: i,
        id,
        ...(step.description ? { description: step.description } : {}),
        step,
      });
    }
  }
  return {
    schema: 'sharkcraft.migration-plan/v1',
    migration: { id: migration.id, title: migration.title },
    plannedSteps,
    totalEdits,
    totalFiles,
  };
}
