import type { IVerdictCoverage } from '@shrkcrft/core';
import type { BoundarySeverity, IBoundaryRuleCoverage, IBoundaryViolation, IUnreadFile } from '@shrkcrft/boundaries';
import type { IBoundaryStaleExceptionFinding } from './boundary-stale-exception-finding.model.ts';

/** One SELECTED rule's result in a boundary check. */
export interface IBoundaryRuleCheck {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: BoundarySeverity;
  /**
   * The verdict word, over the REPORTED scope: `failed` when it has reported
   * violations or stale exceptions, OR when it governed nothing and fails on
   * empty (`failedOnEmpty` — the wiring plane's mapping, so the gate envelope
   * counts it in `failed`); `skipped` when it governed nothing otherwise.
   * Whether the rule EXAMINED anything is `detail.status` (the engine's word) —
   * "evaluated" / "checked nothing" counts read that, never this.
   */
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly skipReason?: string;
  /** A skip that fails the run (`failOnEmpty`). */
  readonly failedOnEmpty?: boolean;
  /** The changeset touched this rule's definition: every violation it produces is reported. */
  readonly escalated?: boolean;
  /**
   * The engine's verdict coverage (scope globs) — read, never recomputed —
   * folded through `readScopeCoverage` when a governed file in the rule's
   * reported scope could not be read ({@link unread}): then `examined R of
   * R+U files`, naming each unread path, so the rule settles PARTIAL (2).
   */
  readonly coverage: IVerdictCoverage;
  /**
   * Governed files in this rule's REPORTED scope the scan could not read. A
   * rule whose zero governed files is caused by one of these matched a file
   * it could not examine: it is never `failedOnEmpty`, never "checked
   * nothing", and never a pass (see `boundaryRuleCheckedNothing`).
   */
  readonly unread?: readonly IUnreadFile[];
  /** What each unit of the rule matched. */
  readonly detail: IBoundaryRuleCoverage;
  /** This rule's REPORTED violations. */
  readonly violations: readonly IBoundaryViolation[];
  /** This rule's REPORTED stale exceptions — each fails the rule. */
  readonly staleExceptions: readonly IBoundaryStaleExceptionFinding[];
}
