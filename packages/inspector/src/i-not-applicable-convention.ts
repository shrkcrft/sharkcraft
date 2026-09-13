import type { ConventionSeverity } from '@shrkcrft/plugin-api';
import type { IConventionApplicabilityReason } from './i-convention-applicability-reason.ts';

/**
 * A convention `conventions check` did NOT evaluate because it does not apply
 * here (round 15, 15.1) — printed in text and in `--json` `notApplicable[]`,
 * never a silent skip.
 */
export interface INotApplicableConvention {
  readonly conventionId: string;
  /** The convention's declared severity — THE closed set `IConvention.severity` uses (round 15 follow-up, F8). */
  readonly severity: ConventionSeverity;
  readonly sourceFile: string;
  readonly packageName?: string;
  /** The declared filters that excluded it (never empty). */
  readonly reasons: readonly IConventionApplicabilityReason[];
}
