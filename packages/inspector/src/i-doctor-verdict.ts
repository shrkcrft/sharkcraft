import type { DoctorVerdictKind } from './doctor-verdict-kind.ts';

/** A doctor run, settled once (`doctorVerdict`). */
export interface IDoctorVerdict {
  readonly verdict: DoctorVerdictKind;
  /** True only for `DoctorVerdictKind.Ready`. */
  readonly ready: boolean;
  /** Core's `coverageShortfall` of each doctor coverage record that has one. */
  readonly shortfalls: readonly string[];
}
