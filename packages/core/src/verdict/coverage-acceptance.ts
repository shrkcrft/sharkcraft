import { coverageGap } from './coverage-gap.ts';
import { coverageShortfall } from './coverage-shortfall.ts';
import type { IVerdictCoverage } from './verdict-coverage.ts';

/**
 * The line to print when a real gap was waived by an explicit acceptance, or
 * `undefined` when there is no gap or the gap still vetoes the verdict.
 *
 * An accepted gap is the one case where a clean verdict sits over an
 * incompletely-examined scope, so it must never be silent: the verdict line
 * prints `accepted by <acceptedBy>: <the gap>` next to the clean sentence.
 * Derived from {@link coverageGap} and {@link coverageShortfall} rather than
 * re-deciding acceptance, so the printed acceptance and the exit code cannot
 * disagree.
 */
export function coverageAcceptance(c: IVerdictCoverage): string | undefined {
  const gap = coverageGap(c);
  if (gap === undefined || coverageShortfall(c) !== undefined) return undefined;
  return `accepted by ${c.acceptedBy}: ${gap}`;
}
