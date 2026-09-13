import { coverageAcceptance } from './coverage-acceptance.ts';
import { coverageShortfall } from './coverage-shortfall.ts';
import type { ISettledVerdict } from './settled-verdict.ts';
import type { IVerdictCoverage } from './verdict-coverage.ts';

/**
 * The exits this fold names. They mirror the CLI's `ExitCode` enum (which core
 * cannot import): 0 verified pass · 2 not verified · 3 usage error; anything
 * else is a failure.
 */
const EXIT_VERIFIED_PASS = 0;
const EXIT_NOT_VERIFIED = 2;
const EXIT_USAGE_ERROR = 3;

/**
 * THE exit guard: a verb PROPOSES an exit from what it found, and the coverage
 * of what it examined may veto a clean one.
 *
 *   - proposed `0` with any shortfall → `2` (ran, but proved nothing about the
 *     part it never examined — never a pass);
 *   - `1` is never changed: a violation found in a partial scope is still real;
 *   - `2` and `3` are never changed.
 *
 * Every CLI verdict verb reaches this through `buildGateEnvelope` (or
 * directly, for a verb with no envelope), and engines below the CLI (the
 * boundary orchestrator) call it too — ONE settle derivation, so no surface
 * can print a clean verdict over an unexamined scope by forgetting a check, and
 * no two surfaces can settle the same coverage differently. The shortfall rule
 * itself is {@link coverageShortfall}.
 */
export function settleVerdict(
  proposed: number,
  coverage: readonly IVerdictCoverage[],
): ISettledVerdict {
  const shortfalls: string[] = [];
  const acceptances: string[] = [];
  for (const c of coverage) {
    const prefix = c.subject ? `${c.subject}: ` : '';
    const shortfall = coverageShortfall(c);
    if (shortfall !== undefined) shortfalls.push(prefix + shortfall);
    const acceptance = coverageAcceptance(c);
    if (acceptance !== undefined) acceptances.push(prefix + acceptance);
  }
  const exit = proposed === EXIT_VERIFIED_PASS && shortfalls.length > 0 ? EXIT_NOT_VERIFIED : proposed;
  // An acceptance is a statement about a CLEAN verdict: "this green stands on a
  // gap that <who> waived". Over a 1/2/3 nothing was granted, so reporting one
  // would put `accepted` next to a not-verified exit — the self-contradicting
  // envelope `--allow-empty` used to produce on an empty changeset.
  const accepted = exit === EXIT_VERIFIED_PASS ? acceptances : [];
  return { exit, verdict: verdictFor(exit), shortfalls, accepted };
}

function verdictFor(exit: number): ISettledVerdict['verdict'] {
  if (exit === EXIT_VERIFIED_PASS) return 'pass';
  if (exit === EXIT_NOT_VERIFIED) return 'not-verified';
  if (exit === EXIT_USAGE_ERROR) return 'usage-error';
  return 'fail';
}
