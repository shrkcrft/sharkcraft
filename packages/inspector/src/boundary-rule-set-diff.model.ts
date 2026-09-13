import type { IBoundaryRuleCoverage, IBoundaryUnitFinding, IBoundaryViolation } from '@shrkcrft/boundaries';
import type { IBoundaryLoadIssue } from './boundary-load-issue.model.ts';

/** One import edge, keyed without its rule — so a renamed rule is not churn. */
interface IBoundaryFlaggedEdge {
  readonly file: string;
  readonly line: number;
  readonly importSpecifier: string;
}

/**
 * What a candidate rule set WOULD flag relative to the active one (round 11,
 * 3.3#3, `check boundaries --diff-against <file>`). Both sides are evaluated by
 * the gate's own engine against ONE scan, so the delta is purely a rule delta —
 * a dry-run that is not the gate's engine would be a second engine.
 */
export interface IBoundaryRuleSetDiff {
  readonly schema: 'sharkcraft.boundary-rule-diff/v1';
  readonly candidateFile: string;
  /** Candidate rule ids not in the active set. */
  readonly rulesAdded: readonly string[];
  /** Candidate rule ids that replace an active rule of the same id. */
  readonly rulesReplaced: readonly string[];
  readonly added: readonly IBoundaryViolation[];
  readonly removed: readonly IBoundaryViolation[];
  readonly unchanged: number;
  readonly perRule: readonly {
    readonly ruleId: string;
    readonly added: number;
    readonly removed: number;
    readonly unchanged: number;
  }[];
  readonly edgeLevel: {
    readonly newlyFlagged: readonly IBoundaryFlaggedEdge[];
    readonly noLongerFlagged: readonly IBoundaryFlaggedEdge[];
  };
  readonly before: { readonly rules: number; readonly counts: { readonly error: number; readonly warning: number; readonly info: number } };
  readonly after: { readonly rules: number; readonly counts: { readonly error: number; readonly warning: number; readonly info: number } };
  /**
   * The candidate rules' coverage in the proposed evaluation — a dead candidate
   * scope is flagged here. Round 13 (P2): each record went through THE unread
   * re-settle `check boundaries` uses (`boundaryUnitLiveness`) and its read
   * scope (`readScopeCoverage`), so an unreadable governed file is never a pass
   * here and a dead unit it could refute is Unproven, not reported.
   */
  readonly candidateCoverage: readonly IBoundaryRuleCoverage[];
  /** The candidate rules' expectEmpty units whose target does not exist — accepted (round 13). */
  readonly intendedEmpty: readonly IBoundaryUnitFinding[];
  /** The candidate rules' expectEmpty units whose target now exists — stale markers (round 13). */
  readonly wentLive: readonly IBoundaryUnitFinding[];
  /** The candidate units `--fail-on-dead-units` fails (core `selectorUnitFails`); each makes the proposal 1. */
  readonly failingUnits: readonly IBoundaryUnitFinding[];
  readonly loadIssues: readonly IBoundaryLoadIssue[];
  /**
   * 1 when the proposal ADDS an error-severity violation, a candidate rule
   * failed to load, a candidate fails on empty, or a candidate unit fails under
   * `--fail-on-dead-units`; else 0; 3 for an unknown `--rule`.
   */
  readonly proposedExit: number;
  readonly unknownRuleId?: string;
}
