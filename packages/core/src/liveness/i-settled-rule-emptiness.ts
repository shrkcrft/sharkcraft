import type { IVerdictCoverage } from '../verdict/verdict-coverage.ts';
import type { RuleEmptiness } from './rule-emptiness.ts';
import type { RuleEmptinessCause } from './rule-emptiness-cause.ts';

/** `settleRuleEmptiness`'s answer — how the plane reports the rule. */
export interface ISettledRuleEmptiness {
  readonly state: RuleEmptiness;
  /** Why, when {@link state} is `Stale`. */
  readonly cause?: RuleEmptinessCause;
  /**
   * The rule checked nothing and nothing accepts that: report it `skipped` —
   * or `failed` when {@link fails}. False for Matched, Unread, IntendedEmpty and
   * AssertedEmptyOutput (report those `passed`).
   */
  readonly skipped: boolean;
  /** `skipped` under failOnEmpty: a hard failure (1). A soft skip is NOT VERIFIED (2). */
  readonly fails: boolean;
  /** The skip sentence, when {@link skipped}. */
  readonly skipReason?: string;
  /**
   * The coverage record the rule carries for this state, when the settle owns
   * it: IntendedEmpty → the rule's unit acceptance (the SAME object as
   * `liveness.acceptance`, so the envelope folds it once); AssertedEmptyOutput
   * → the fence acceptance (`acceptedBy: 'expectEmpty: true'`). Undefined
   * otherwise — the plane keeps its own record.
   */
  readonly coverage?: IVerdictCoverage;
}
