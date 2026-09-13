import { QualityGateExamination } from './quality-gate-examination.ts';
import { QualityGateStatus } from './quality-gate-status.ts';
import { examineQualityGate } from './quality-report-coverage.ts';
import type { IQualityGateResult } from './quality-report.ts';

/**
 * THE row status of one quality gate, for every renderer (the dashboard, the
 * HTML report, the report site), derived from the one classification
 * (`examineQualityGate`) that `overall` and `shrk quality` also read.
 *
 *   a deliberate (optional) skip                       → skipped
 *   a gate that ran and failed (a finding dominates)   → fail / warn
 *   unexamined: could not run, examined nothing while
 *   required, or passed over part of its scope         → not-verified
 *   anything else                                      → pass
 *
 * Before round 11 each renderer re-derived the row from `g.passed`, so a gate
 * whose boundary rule had a dead scope glob read `pass` / `OK` next to an
 * overall `not-verified`.
 */
export function qualityGateStatus(g: IQualityGateResult): QualityGateStatus {
  const exam = examineQualityGate(g);
  if (exam === QualityGateExamination.DeliberateSkip) return QualityGateStatus.Skipped;
  if (g.executed && !g.passed) return g.blocking ? QualityGateStatus.Fail : QualityGateStatus.Warn;
  if (exam === QualityGateExamination.Unexamined) return QualityGateStatus.NotVerified;
  return QualityGateStatus.Pass;
}
