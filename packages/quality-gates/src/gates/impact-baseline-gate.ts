import { ImpactReportStore, diffImpactReports } from '@shrkcrft/impact-engine';
import type { IGateResult } from '../schema/quality-gate.ts';

export interface IImpactBaselineGateOptions {
  /**
   * When true, a worsened baseline fails the gate. Default `false`
   * (warn) — growing impact can be intentional in early development.
   */
  failOnWorsened?: boolean;
}

/**
 * Compare the last impact run against the frozen baseline. Skipped
 * when either side is missing. Warn / fail when the run is worse
 * than baseline along any axis (more dependents, more packages, or a
 * higher risk classification).
 */
export function impactBaselineGate(
  projectRoot: string,
  options: IImpactBaselineGateOptions = {},
): IGateResult {
  const start = Date.now();
  const failOnWorsened = options.failOnWorsened ?? false;
  const store = new ImpactReportStore(projectRoot);
  const baseline = store.readBaseline();
  const last = store.read();
  if (!baseline) {
    return {
      id: 'impact-baseline',
      label: 'Impact baseline',
      status: 'skipped',
      message: 'No baseline frozen. Run `shrk impact baseline write` to opt in.',
      durationMs: Date.now() - start,
    };
  }
  if (!last) {
    return {
      id: 'impact-baseline',
      label: 'Impact baseline',
      status: 'skipped',
      message: 'Baseline present but no recent impact run to compare against.',
      nextCommands: ['shrk impact --via-graph'],
      durationMs: Date.now() - start,
    };
  }
  const delta = diffImpactReports(baseline, last);
  if (!delta.worsened) {
    return {
      id: 'impact-baseline',
      label: 'Impact baseline',
      status: 'pass',
      message:
        `Within baseline — dependents ${delta.dependentDelta >= 0 ? '+' : ''}${delta.dependentDelta}, ` +
        `packages ${delta.packageDelta >= 0 ? '+' : ''}${delta.packageDelta}.`,
      details: { delta },
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'impact-baseline',
    label: 'Impact baseline',
    status: failOnWorsened ? 'fail' : 'warn',
    message:
      `Worsened — dependents ${delta.dependentDelta >= 0 ? '+' : ''}${delta.dependentDelta}, ` +
      `packages ${delta.packageDelta >= 0 ? '+' : ''}${delta.packageDelta}` +
      (delta.riskDrift ? `, risk ${delta.riskDrift}` : '') +
      '.',
    details: { delta },
    nextCommands: [
      'shrk impact baseline show',
      'shrk impact --via-graph <target>',
      'shrk impact baseline write',
    ],
    durationMs: Date.now() - start,
  };
}
