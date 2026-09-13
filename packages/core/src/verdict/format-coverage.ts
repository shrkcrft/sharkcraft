import { coverageAcceptance } from './coverage-acceptance.ts';
import type { IVerdictCoverage } from './verdict-coverage.ts';

/**
 * The always-printed scope clause for a verdict: `examined 3 of 3 rules`,
 * `capped at 2000 of 2101 files`, or `examined 2 of 3 registered tokens
 * (accepted by registeredExtras)`.
 *
 * Printed on clean verdicts too. A number the reader can compare to the
 * request is the whole point — a verdict that omits it cannot be told apart
 * from one that examined everything.
 */
export function formatCoverage(c: IVerdictCoverage): string {
  const verb = c.capped === true ? 'capped at' : 'examined';
  const base = `${verb} ${c.examined} of ${c.expected} ${c.unit}`;
  return coverageAcceptance(c) !== undefined ? `${base} (accepted by ${c.acceptedBy})` : base;
}
