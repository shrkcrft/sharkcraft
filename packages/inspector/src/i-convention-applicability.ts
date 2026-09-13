import type { IConventionApplicabilityReason } from './i-convention-applicability-reason.ts';

/** THE answer to "does this convention apply here?" — `conventionApplicability` (round 15, 15.1). */
export interface IConventionApplicability {
  /** True iff every declared filter matched (an absent or empty filter imposes nothing). */
  readonly applicable: boolean;
  /** One judgement per DECLARED filter, workspace filters first — empty when `appliesTo` declares none. */
  readonly reasons: readonly IConventionApplicabilityReason[];
}
