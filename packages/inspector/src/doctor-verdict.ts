import { coverageShortfall } from '@shrkcrft/core';
import type { IDoctorResult } from './doctor-result.ts';
import { DoctorVerdictKind } from './doctor-verdict-kind.ts';
import type { IDoctorVerdict } from './i-doctor-verdict.ts';

/**
 * THE settlement of one doctor run.
 *
 *   an error-severity check          → `errors`
 *   else any coverage shortfall      → `not-verified` (never ready)
 *   else                             → `ready`
 *
 * `IDoctorResult.passed` stays errors-only (its long-standing meaning); the
 * coverage the doctor could not verify is read here, through core's
 * `coverageShortfall`, the same records `shrk doctor` settles its exit on.
 * `shrk check`, the dashboard and MCP `inspect_sharkcraft_setup` read this
 * instead of `passed`, so none of them calls a setup ready over a compiled
 * pack build the doctor could not compare with its source.
 */
export function doctorVerdict(result: IDoctorResult): IDoctorVerdict {
  const shortfalls = (result.coverage ?? []).flatMap((c) => {
    const s = coverageShortfall(c);
    return s === undefined ? [] : [s];
  });
  const verdict = !result.passed
    ? DoctorVerdictKind.Errors
    : shortfalls.length > 0
      ? DoctorVerdictKind.NotVerified
      : DoctorVerdictKind.Ready;
  return { verdict, ready: verdict === DoctorVerdictKind.Ready, shortfalls };
}
