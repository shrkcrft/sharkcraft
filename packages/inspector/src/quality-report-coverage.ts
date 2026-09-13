import type { IVerdictCoverage } from '@shrkcrft/core';
import { QualityGateExamination } from './quality-gate-examination.ts';
import type { IQualityGateResult } from './quality-report.ts';

/**
 * THE classification of one quality gate's run:
 *
 *   - not executed (it threw, or MCP would not run it)  → unexamined
 *   - `data.examinedNothing` (zero tests, zero rules)   → unexamined when the
 *     gate is required (blocking), a deliberate skip when it is optional
 *   - passed, with `data.partial` (a boundary rule whose scope glob went dead,
 *     an agent test the runner could not evaluate)     → unexamined
 *   - anything else                                     → examined
 *
 * `shrk quality` maps each gate onto its item through this one function, and
 * `buildQualityReport` derives `overall` from it, so no consumer can read a
 * pass over a gate the other calls partial.
 */
export function examineQualityGate(g: IQualityGateResult): QualityGateExamination {
  if (!g.executed) return QualityGateExamination.Unexamined;
  if (g.data?.['examinedNothing'] === true) {
    return g.blocking ? QualityGateExamination.Unexamined : QualityGateExamination.DeliberateSkip;
  }
  if (g.passed && g.data?.['partial'] === true) return QualityGateExamination.Unexamined;
  return QualityGateExamination.Examined;
}

/**
 * What a quality report examined, as one coverage record (unit `quality
 * gates`): every gate but the deliberate skips was asked for, and the
 * unexamined ones are named. Core's `coverageShortfall` over it is what turns
 * a clean report into `not-verified`.
 */
export function qualityReportCoverage(gates: readonly IQualityGateResult[]): IVerdictCoverage {
  const exams = gates.map((g) => ({ id: g.id, exam: examineQualityGate(g) }));
  const deliberate = exams.filter((e) => e.exam === QualityGateExamination.DeliberateSkip).length;
  const unexamined = exams.filter((e) => e.exam === QualityGateExamination.Unexamined).map((e) => e.id);
  const expected = gates.length - deliberate;
  return {
    unit: 'quality gates',
    expected,
    examined: expected - unexamined.length,
    ...(unexamined.length > 0
      ? {
          unexamined,
          reason: 'could not run, examined nothing while required, or examined only part of their scope',
        }
      : {}),
  };
}
