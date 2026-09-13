import { settleUnitLiveness, type ISettledUnitLiveness } from '@shrkcrft/core';
import { globListLivenessInput } from './glob-list-liveness-input.ts';
import type { IGlobLivenessRequest } from './i-glob-liveness-request.ts';

/**
 * Settle a gate rule's glob lists through core's one authority,
 * `settleUnitLiveness`, over THE gate-plane observation predicate
 * (`globListLivenessInput`) — the call every plane engine makes before it
 * decides what an empty rule is (`settleRuleEmptiness` takes the result as its
 * `liveness`). `settled.dead` holds UNMARKED dead units only; a marked glob is
 * intended-empty or went-live, and `settled.acceptance` is its printed record.
 */
export function settleGlobLists(request: IGlobLivenessRequest): ISettledUnitLiveness {
  return settleUnitLiveness(globListLivenessInput(request));
}
