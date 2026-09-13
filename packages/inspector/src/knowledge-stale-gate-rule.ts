import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IKnowledgeStaleGateViolation } from './knowledge-stale-gate-violation.ts';

/**
 * One rule of the knowledge stale-check verdict (`knowledge-references`, or
 * `knowledge-files` for a knowledge file that never loaded). Structurally a
 * CLI gate-envelope rule (`IGateRuleResult` of type `knowledge`): the verb
 * passes it to `buildGateEnvelope` as is, and `shrk quality` / every
 * `buildQualityReport` consumer settles the SAME record through core's
 * `settleVerdict` — the inspector cannot import the CLI's type, so the shape
 * lives here, below both.
 */
export interface IKnowledgeStaleGateRule {
  readonly id: string;
  readonly type: 'knowledge';
  readonly status: 'passed' | 'failed' | 'skipped' | 'error';
  readonly severity: 'error' | 'warning';
  readonly counts: Readonly<Record<string, number>>;
  readonly violations: readonly IKnowledgeStaleGateViolation[];
  readonly skipReason?: string;
  readonly error?: string;
  /** What the rule examined against what it was asked to. REQUIRED. */
  readonly coverage: IVerdictCoverage;
  /**
   * An ACCEPTANCE riding next to `coverage` (round 13), folded by the envelope
   * exactly like a selector unit acceptance (`ruleVerdictRecords`): the failing
   * references this run's mode waived — `required: false` under `--ci` /
   * `--strict`, or outside the chosen `--fail-on` categories — printed in
   * `accepted` at exit 0, so the ✓ line never stands over a STALE row in
   * silence. Never a shortfall; `rules[].status` never reads it.
   */
  readonly unitAcceptance?: IVerdictCoverage;
}
