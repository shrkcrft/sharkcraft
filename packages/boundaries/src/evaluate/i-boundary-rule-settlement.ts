import type {
  ISettledRuleEmptiness,
  ISettledUnitLiveness,
  IUnitStateLists,
  IVerdictCoverage,
} from '@shrkcrft/core';
import type { BoundaryRuleStatus, IBoundaryDeadUnit } from './evaluate-boundaries.ts';

/** `settleBoundaryRule`'s answer: how one rule settled — its units, its emptiness, and the fields its coverage record carries. */
export interface IBoundaryRuleSettlement {
  /** Every unit's state (core `settleUnitLiveness`). */
  readonly settled: ISettledUnitLiveness;
  /** What the rule's empty scope is (core `settleRuleEmptiness`). */
  readonly emptiness: ISettledRuleEmptiness;
  readonly status: BoundaryRuleStatus;
  /** Why the rule checked nothing, when `skipped`. */
  readonly skipReason?: string;
  /** A skip that fails the run (`failOnEmpty`). */
  readonly failedOnEmpty: boolean;
  /** The primary verdict record: the scope-glob shortfall (record A), or the acceptance itself for an IntendedEmpty rule. */
  readonly coverage: IVerdictCoverage;
  /** Record B — the rule's intended-empty units, `acceptedBy: 'expectEmpty'`. */
  readonly unitAcceptance?: IVerdictCoverage;
  /** The rule's dead / intended-empty / went-live unit lines (`unitStateLists`), when it has any. */
  readonly units?: IUnitStateLists;
  /** The settled `.dead` (UNMARKED units only), as the boundary JSON has always reported them. */
  readonly deadUnits: readonly IBoundaryDeadUnit[];
}
