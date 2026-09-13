import type { IGlobUnitMeasure } from '../scan/i-glob-unit-measure.ts';
import type { IDeadGlobUnit } from './i-dead-glob-unit.ts';
import type { IGlobNegation } from './i-glob-negation.ts';

/** One glob list's units, judged by `globListUnits`: the dead ones, the live negations, and how many were checked. */
export interface IGlobListUnits {
  readonly dead: readonly IDeadGlobUnit[];
  /** Negations that exclude at least one file, with the count. */
  readonly negations: readonly IGlobNegation[];
  /** Distinct globs (negations included) examined. */
  readonly checked: number;
  /**
   * True when the list's OWN negations emptied it: its inclusion globs matched
   * at least one file, every one of them is excluded, and no unread entry the
   * list keeps in scope could hold a survivor. A rule over such a list that
   * matched nothing is the author's `!` at work — not a stale selector.
   */
  readonly allExcluded: boolean;
  /**
   * Every distinct glob's measure (`measureGlobList`: an inclusion glob's raw
   * and effective matches, a negation's exclusions) — what a went-live unit's
   * sentence quotes (`it now matches 3 file(s)`). Set by `globListUnits`.
   */
  readonly measures?: readonly IGlobUnitMeasure[];
}
