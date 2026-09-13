import type { IGlobNegation } from './i-glob-negation.ts';

/** `!src/**\/*.spec.ts (1 file), !docs/drafts/** (3 files)` — each negation with what it excluded. */
function describeNegations(negations: readonly IGlobNegation[]): string {
  return negations.map((n) => `${n.glob} (${n.excludes} file${n.excludes === 1 ? '' : 's'})`).join(', ');
}

/**
 * THE cause of a list its OWN negations emptied — its inclusion globs matched
 * files and every one was excluded as written — for the policy plane's skip
 * and coverage reasons. Not a stale selector, and never worded as one.
 */
export function allExcludedCause(negations: readonly IGlobNegation[]): string {
  return `every file its inclusion globs select is excluded by its own negations (${describeNegations(negations)})`;
}

/**
 * THE skip reason of an extraction SOURCE its own negations emptied (round 12
 * review, R12-DOC-2) — the words `gates coverage` prints for the same rule, so
 * `check wiring`, `gates check` and the NOT VERIFIED line no longer say "0
 * files matched the source globs" (a file DID match, then was excluded).
 */
export function emptiedByNegationsReason(negations: readonly IGlobNegation[]): string {
  return `matched nothing after its own negations: every file its inclusion globs select is excluded (${describeNegations(negations)})`;
}
