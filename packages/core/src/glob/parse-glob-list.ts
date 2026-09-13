import type { IGlobList } from './i-glob-list.ts';

/**
 * THE one parser for what a leading `!` means in a glob list.
 *
 * It lives in `core` because two layers must read one definition: validation
 * (the config loader, the pack-plane merge seam, `validateWiringSource`) and
 * matching (`globListSelects` in `@shrkcrft/boundaries`). Before round 12 the
 * boundary plane had its own `!` parser while every gate plane compiled `!x`
 * to a literal glob that matched nothing — so a negation the author wrote was
 * silently ignored, and the files it named stayed in scope.
 */

/** True when `glob` is a negation (`!src/**\/*.spec.ts`). */
export function isNegatedGlob(glob: string): boolean {
  return glob.startsWith('!');
}

/**
 * Split a glob list into its inclusion globs and its negations (the `!` is
 * stripped). A malformed entry (`!`, `!!x`) is not repaired here — it is a
 * validation error ({@link globListProblem}) and never reaches an engine from a
 * loaded config; parsed anyway, it matches nothing.
 */
export function parseGlobList(globs: readonly string[]): IGlobList {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const g of globs) {
    if (isNegatedGlob(g)) exclude.push(g.slice(1));
    else include.push(g);
  }
  return { include, exclude };
}

/**
 * What is wrong with a glob list's SHAPE, or `undefined` when it is well
 * formed. Every shape rejected here used to load and enforce nothing.
 *
 * - a bare `!` is an empty negation;
 * - `!!x` is a double negation (write the inclusion glob instead);
 * - a list of negations only selects nothing, forever.
 *
 * `negationMeaning` names what a `!` entry does on the caller's plane, for the
 * negation-only message: gate planes EXCLUDE (the default), the boundary plane
 * EXEMPTS (`'are exemptions'`). An empty list is not judged here — each plane
 * already states whether it may be empty.
 */
export function globListProblem(
  globs: readonly string[],
  negationMeaning = 'exclude from what the others select',
): string | undefined {
  for (const g of globs) {
    if (g === '!') return '"!" is not a glob (an empty negation)';
    if (g.startsWith('!!')) return `double negation "${g}" is not supported — write the inclusion glob`;
  }
  if (globs.length > 0 && globs.every(isNegatedGlob)) {
    return `needs at least one inclusion glob (entries starting with "!" ${negationMeaning})`;
  }
  return undefined;
}

/**
 * What is wrong with an EXEMPTION list (policy `exemptFiles`, generated
 * `handMaintained`, boundary `exemptFiles`), or `undefined`. An exemption list
 * takes plain globs: a `!` there would read as "exempt everything else", which
 * is never what the author meant and which no engine implements.
 */
export function exemptionListProblem(globs: readonly string[]): string | undefined {
  const negated = globs.find(isNegatedGlob);
  if (negated === undefined) return undefined;
  return `"${negated}": an exemption list takes plain globs — "!" here would mean "exempt everything else"`;
}
