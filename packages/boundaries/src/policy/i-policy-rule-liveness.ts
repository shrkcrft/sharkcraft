import type { ISettledUnitLiveness } from '@shrkcrft/core';
import type { IGlobListUnits } from '../util/i-glob-list-units.ts';

/**
 * One policy rule's own `files` judged per unit and settled with its
 * `expectEmpty` markers (round 13) — what `evaluatePolicy` decides a rule that
 * scanned nothing from (`settleRuleEmptiness`), and what `runPolicyLint`
 * reports as its dead / intended-empty / went-live units.
 */
export interface IPolicyRuleLiveness {
  /** The list's units, by the one dead-unit decision (`globListUnits`). */
  readonly units: IGlobListUnits;
  /** The settle (`settleUnitLiveness` over `globListLivenessInput`). */
  readonly liveness: ISettledUnitLiveness;
}
