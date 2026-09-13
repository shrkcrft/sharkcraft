import { formatUnitLiveness, UnitLivenessState, type IUnitLiveness } from '@shrkcrft/core';

/**
 * The verdict line an asset doctor prints when `--fail-on-dead-units` is what
 * failed it (round 13 review). `verdictLine` prints nothing for a `1` with no
 * shortfall ("the verb already printed them") — but these doctors printed only
 * INFO issues, so the run exited 1 with no line saying why (`self-config
 * doctor`'s header even read `verdict OK`):
 *
 *   Verdict: registration-hint doctor needs attention — 1 went-live expectEmpty unit(s) (--fail-on-dead-units)
 *     • <formatUnitLiveness(u)>
 *
 * `failing` is `assetDoctorFailingUnits(...)`. Empty when no unit fails (the
 * doctor's errors and warnings speak for themselves).
 */
export function assetDoctorFailureLine(label: string, failing: readonly IUnitLiveness[]): string {
  if (failing.length === 0) return '';
  const dead = failing.filter((u) => u.state === UnitLivenessState.Dead).length;
  const live = failing.length - dead;
  const parts = [
    ...(dead > 0 ? [`${dead} dead unit(s)`] : []),
    ...(live > 0 ? [`${live} went-live expectEmpty unit(s)`] : []),
  ];
  return [
    `Verdict: ${label} needs attention — ${parts.join(', ')} (--fail-on-dead-units)`,
    ...failing.map((u) => `  • ${formatUnitLiveness(u)}`),
  ].join('\n');
}
