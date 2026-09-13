/**
 * The command-TYPO tolerance policy for command NAMES and flags.
 *
 * `main.ts` (unknown verb), `help` (unknown topic), the flag guard and the
 * command-string resolver (`resolveCommandString`) used to carry their own
 * Levenshtein copies with their own tolerances; two of them agreed only by
 * coincidence. They all read this now.
 *
 * The DISTANCE is not defined here: it is `@shrkcrft/inspector`'s `levenshtein`
 * (nearest-id.ts), the one edit distance every "did you mean" in the tree
 * uses. An unknown DECLARED ID (a test id, a rule id, a check id) is not a
 * command typo — those sites call `nearestIds` (prefix / substring affinity,
 * a length-scaled cutoff), never this module.
 */
import { levenshtein } from '@shrkcrft/inspector';

/** Levenshtein edit distance — THE one (`@shrkcrft/inspector` `levenshtein`), under the CLI's name. */
export const editDistance: (a: string, b: string) => number = levenshtein;

/**
 * Typo tolerance for an attempt: `max(1, floor(len / 4))` edits. A
 * fingers-on-keys typo (`doctr`) is inside it; a different word is not.
 */
export function typoTolerance(attempt: string): number {
  return Math.max(1, Math.floor(attempt.length / 4));
}

/**
 * Candidates within `tolerance` edits of `attempt` (case-insensitive), nearest
 * first, ties broken lexically — deterministic. At most `limit`.
 */
export function closestMatches(
  attempt: string,
  candidates: Iterable<string>,
  limit = 3,
  tolerance: number = typoTolerance(attempt),
): string[] {
  const lower = attempt.toLowerCase();
  const scored: { c: string; d: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const d = editDistance(lower, c.toLowerCase());
    if (d <= tolerance) scored.push({ c, d });
  }
  scored.sort((x, y) => (x.d !== y.d ? x.d - y.d : x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.c);
}

/** The single nearest candidate within `tolerance`, or `undefined`. */
export function nearest(
  attempt: string,
  candidates: Iterable<string>,
  tolerance: number = typoTolerance(attempt),
): string | undefined {
  return closestMatches(attempt, candidates, 1, tolerance)[0];
}
