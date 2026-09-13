import type { ISettledVerdict, IVerdictCoverage } from '@shrkcrft/core';

/**
 * One pack-doctor run, settled: the exit / verdict / shortfalls core's
 * `settleVerdict` gives over the doctor's coverage (packs discovered, compiled
 * artifacts compared to their source), plus the records themselves.
 */
export interface IPackDoctorVerdict extends ISettledVerdict {
  /** The records the verdict settled on — spread more onto them (a verb's `--typecheck`) and re-settle. */
  readonly coverage: readonly IVerdictCoverage[];
  /** Packs discovered — `0` is an empty selection, never a pass. */
  readonly packsDiscovered: number;
  /** True when no pack was discovered: the doctor examined nothing. */
  readonly examinedNothing: boolean;
}
