import type { IVerdictCoverage } from '../verdict/verdict-coverage.ts';
import type { IUnitLiveness } from './i-unit-liveness.ts';
import type { IUnitMark } from './i-unit-mark.ts';

/** `settleUnitLiveness`'s answer: every unit's state, the lists by state, and the coverage records. */
export interface ISettledUnitLiveness {
  /** Every observation, settled, in input order. */
  readonly units: readonly IUnitLiveness[];
  readonly live: readonly IUnitLiveness[];
  /** Unmarked units that match nothing — THE dead-unit list a reporter reports (nothing else may build one). */
  readonly dead: readonly IUnitLiveness[];
  /** Marked units whose target does not exist — accepted, printed. */
  readonly intendedEmpty: readonly IUnitLiveness[];
  /** Marked units whose target now exists — stale markers (drift). */
  readonly wentLive: readonly IUnitLiveness[];
  readonly unproven: readonly IUnitLiveness[];
  /**
   * Record A — the dead shortfall over the COVERAGE-weight units that are
   * judged (every state but IntendedEmpty): `examined` counts the effective
   * ones; Dead, Unproven and a not-effective WentLive are the gap. Emitted only
   * when at least one Coverage unit is judged (or the scan was capped), so an
   * all-intended-empty list never yields an unsuppressed `expected: 0` record.
   * A plane whose primary coverage IS its units (boundary `from`, the asset
   * doctors) uses it as that coverage.
   */
  readonly shortfall?: IVerdictCoverage;
  /**
   * Record B — the acceptance, emitted when any unit is intended-empty:
   * `{ expected: n, examined: 0, unexamined: labels, reason: 'asserted empty —
   * <observed>', acceptedBy: 'expectEmpty' }`. Carry it as the rule's
   * `unitAcceptance`; core `settleVerdict` prints it in `accepted` (exit 0 only).
   */
  readonly acceptance?: IVerdictCoverage;
  /** `[shortfall?, acceptance?]` — for a surface that settles a flat list of records. */
  readonly coverage: readonly IVerdictCoverage[];
  /**
   * Marks whose (list, unit) matched no observation: the reporter never judged
   * a marked unit. A reporter bug (or a list path mismatch) — the r77 census
   * asserts it is empty.
   */
  readonly unobservedMarks: readonly IUnitMark[];
}
