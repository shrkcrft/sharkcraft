/**
 * Helper plan generators.
 *
 * Helpers are one-shot plan-v2 producers for small, well-bounded edits.
 * Dry-run by default and idempotent where the plan engine supports it.
 *
 * No helper writes source directly. The output is a structured
 * `IHelperPlan` containing planned ops (using the existing plan-v2
 * operation set) and a list of advisory conflicts.
 *
 * The engine ships zero built-in helpers. Helpers come from pack
 * contributions when needed.
 */

/**
 * Helper ids are free-form strings — the engine ships zero built-in
 * helpers. Pack contributions register their own ids.
 */
export type HelperId = string;

export interface IHelperDefinition {
  id: HelperId;
  description: string;
  destructive: boolean;
  requiresHumanReview: boolean;
  requiresProfile?: boolean;
  variables: ReadonlyArray<{ name: string; required: boolean; description: string }>;
}

export const HELPERS: ReadonlyArray<IHelperDefinition> = Object.freeze([]);

export interface IHelperPlanOp {
  kind: 'append' | 'insert-after' | 'insert-before' | 'create' | 'replace';
  targetPath: string;
  snippet?: string;
  anchor?: string;
  fromPattern?: string;
}

export interface IHelperPlan {
  schema: 'sharkcraft.helper-plan/v1';
  helperId: HelperId;
  generatedAt: string;
  ops: readonly IHelperPlanOp[];
  conflicts: readonly string[];
  manualSteps: ReadonlyArray<{ kind: string; description: string }>;
  destructive: boolean;
  requiresHumanReview: boolean;
}

export const HELPER_SYNTHETIC_TEMPLATE = '__helper__';

interface IHelperBuildInput {
  helperId: HelperId;
  projectRoot: string;
  vars: Record<string, string>;
  profile?: unknown;
}

export function buildHelperPlan(_input: IHelperBuildInput): IHelperPlan {
  throw new Error(
    `No built-in helpers are registered. Pack-contributed helpers can be installed via a sharkcraft pack.`,
  );
}

export function helperPlanToSavedPlan(
  plan: IHelperPlan,
  _projectRoot: string,
): unknown {
  return plan;
}

export function renderHelperPlanText(plan: IHelperPlan): string {
  const lines: string[] = [];
  lines.push(`Helper plan: ${String(plan.helperId)}`);
  lines.push(`Ops: ${plan.ops.length}`);
  lines.push(`Conflicts: ${plan.conflicts.length}`);
  return lines.join('\n');
}
