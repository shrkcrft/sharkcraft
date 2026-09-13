import { coverageShortfall } from './coverage-shortfall.ts';
import type { IVerdictCoverage } from './verdict-coverage.ts';

/**
 * A rule's status after its coverage has been compared to its request — THE
 * derivation of `partial`, shared by every surface that reports one rule.
 *
 * A rule its producer reported `passed` whose coverage has a shortfall found
 * nothing wrong in what it examined and did not examine everything it was
 * asked to: it is `partial`, never `passed`. Every other status is returned
 * unchanged — a failure found in a partial scope is still a failure, and a
 * skipped or errored rule already says it proved nothing.
 *
 * The CLI's gate-envelope builder and the wiring explain engine both call this,
 * so `gates check` and `gates explain` cannot disagree about the same rule —
 * the two-authorities shape round 11 closed. It lives in core so an engine
 * below the CLI (e.g. `@shrkcrft/boundaries`) can apply the same rule.
 */
export function settleRuleStatus<S extends string>(
  status: S,
  coverage: IVerdictCoverage,
): S | 'partial' {
  return status === 'passed' && coverageShortfall(coverage) !== undefined ? 'partial' : status;
}
