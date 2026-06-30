import { analyzeGraphImpact } from '@shrkcrft/impact-engine';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IImpactGateOptions {
  /** Git ref to diff against (e.g. 'main', 'origin/main', 'HEAD~5'). */
  sinceRef?: string;
  /** Risk levels that fail the gate. Default ['critical']. */
  failOn?: readonly ('high' | 'critical')[];
  /**
   * Explicit changed-file set to analyze. Used by `--changed-only` / `--staged`
   * / `--files` when no `sinceRef` gitref is given. Ignored when `sinceRef` is
   * set (the gitref diff wins). An empty array yields the `skipped` path.
   */
  files?: readonly string[];
}

/** low < medium < high < critical — used for threshold comparison. */
const RISK_RANK: Readonly<Record<string, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function rankOf(risk: string): number {
  return RISK_RANK[risk] ?? 0;
}

/**
 * Impact-engine gate. Analyzes the changeset and runs `analyzeGraphImpact`.
 * When `files` is provided (and no `sinceRef`), the given changed-file set is
 * analyzed directly; otherwise `git diff --name-only` is run against `sinceRef`
 * (default 'main').
 *
 * Failure is THRESHOLD-based, not exact set-membership: the gate ranks
 * low<medium<high<critical and fails when the computed risk is at least as
 * severe as the *least* severe entry in `failOn`. So `--fail-on high` also
 * fails a `critical` change. With the default `['critical']`, `critical` fails
 * and `high` warns. Skipped when no files changed or the graph isn't indexed.
 */
export function impactGate(projectRoot: string, options: IImpactGateOptions = {}): IGateResult {
  const start = Date.now();
  const failOn = options.failOn && options.failOn.length > 0 ? options.failOn : (['critical'] as const);
  const failThreshold = Math.min(...failOn.map((f) => rankOf(f)));

  // Scope: an explicit changed-file set (when no gitref is given) is analyzed
  // directly; otherwise diff against the gitref (default 'main').
  const useFiles = !options.sinceRef && options.files !== undefined;
  const sinceRef = options.sinceRef ?? 'main';
  const label = useFiles ? 'Impact (changed files)' : 'Impact (since ' + sinceRef + ')';
  const analysis = useFiles
    ? analyzeGraphImpact({ kind: 'files', files: options.files ?? [] }, { projectRoot })
    : analyzeGraphImpact({ kind: 'gitref', ref: sinceRef }, { projectRoot });

  if (analysis.diagnostics.some((d) => d.includes('code-graph store missing'))) {
    return {
      id: 'impact',
      label,
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  if (analysis.normalizedTargets.length === 0) {
    return {
      id: 'impact',
      label,
      status: 'skipped',
      message: useFiles ? 'No files changed.' : `No files changed since ${sinceRef}.`,
      durationMs: Date.now() - start,
    };
  }
  const status =
    rankOf(analysis.risk) >= failThreshold ? 'fail' : analysis.risk === 'high' ? 'warn' : 'pass';
  const message =
    status === 'fail'
      ? `Risk: ${analysis.risk}. ${analysis.directDependents.length} direct dependents.`
      : status === 'warn'
        ? `Risk: ${analysis.risk}. Review the validation scope.`
        : `Risk: ${analysis.risk}. Looks safe.`;
  return {
    id: 'impact',
    label,
    status,
    message,
    details: {
      risk: analysis.risk,
      reasons: analysis.riskReasons,
      direct: analysis.directDependents.length,
      transitive: analysis.transitiveDependents.length,
      publicApiTouched: analysis.publicApiTouched,
      validationScope: analysis.validationScope,
    },
    nextCommands: analysis.validationScope.length > 0 ? [...analysis.validationScope] : undefined,
    durationMs: Date.now() - start,
  };
}
