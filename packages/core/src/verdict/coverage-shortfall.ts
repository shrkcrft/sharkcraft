import { coverageGap } from './coverage-gap.ts';
import type { IVerdictCoverage } from './verdict-coverage.ts';

/**
 * THE rule for "may this verdict be clean?" — the one authority every verdict
 * surface defers to. Returns the sentence that vetoes a clean verdict, or
 * `undefined` when the scope was examined (or the gap was explicitly accepted).
 *
 *   - `capped`: always a shortfall. A cap is never acceptable: the remainder was
 *     never looked at, and no flag can make an unread file clean.
 *   - `expected === 0`: a shortfall ("nothing to examine is not a pass") unless
 *     an unconditional `acceptedBy` is set. A ratio never accepts an empty
 *     scope — `--min-referenced 0.5` over zero entries proved nothing.
 *   - `examined < expected`: a shortfall unless `acceptedBy` is set and the
 *     ratio (when one is given) is met.
 *
 * Property (locked by r75-coverage-shortfall.test.ts): the result is
 * `undefined` iff `!capped && ((examined >= expected && expected > 0) ||
 * (acceptedBy && (acceptedRatio === undefined || (expected > 0 &&
 * examined / expected >= acceptedRatio))))`.
 */
export function coverageShortfall(c: IVerdictCoverage): string | undefined {
  const gap = coverageGap(c);
  if (gap === undefined) return undefined;
  if (c.capped === true) return gap;
  if (c.acceptedBy === undefined || c.acceptedBy.length === 0) return gap;
  if (c.acceptedRatio === undefined) return undefined;
  if (c.expected > 0 && c.examined / c.expected >= c.acceptedRatio) return undefined;
  return gap;
}
