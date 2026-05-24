import { analyzeGraphImpact } from '@shrkcrft/impact-engine';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IImpactGateOptions {
  /** Git ref to diff against (e.g. 'main', 'origin/main', 'HEAD~5'). */
  sinceRef?: string;
  /** Risk levels that fail the gate. Default ['critical']. */
  failOn?: readonly ('high' | 'critical')[];
}

/**
 * Impact-engine gate. Reads `git diff --name-only` against `sinceRef`
 * (default 'main') and runs `analyzeGraphImpact`. Fails when the
 * computed risk is in `failOn`. Skipped when no files changed or the
 * graph isn't indexed.
 */
export function impactGate(projectRoot: string, options: IImpactGateOptions = {}): IGateResult {
  const start = Date.now();
  const sinceRef = options.sinceRef ?? 'main';
  const failOn = new Set<string>(options.failOn ?? ['critical']);
  const analysis = analyzeGraphImpact({ kind: 'gitref', ref: sinceRef }, { projectRoot });
  if (analysis.diagnostics.some((d) => d.includes('code-graph store missing'))) {
    return {
      id: 'impact',
      label: 'Impact (since ' + sinceRef + ')',
      status: 'skipped',
      message: 'Skipped — graph index missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  if (analysis.normalizedTargets.length === 0) {
    return {
      id: 'impact',
      label: 'Impact (since ' + sinceRef + ')',
      status: 'skipped',
      message: `No files changed since ${sinceRef}.`,
      durationMs: Date.now() - start,
    };
  }
  const status = failOn.has(analysis.risk) ? 'fail' : analysis.risk === 'high' ? 'warn' : 'pass';
  const message =
    status === 'fail'
      ? `Risk: ${analysis.risk}. ${analysis.directDependents.length} direct dependents.`
      : status === 'warn'
        ? `Risk: ${analysis.risk}. Review the validation scope.`
        : `Risk: ${analysis.risk}. Looks safe.`;
  return {
    id: 'impact',
    label: 'Impact (since ' + sinceRef + ')',
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
