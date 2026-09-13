/**
 * One dead glob inside a gate rule, as `gates coverage` reports it (the
 * `deadGlobUnits` of `sharkcraft.gate-coverage/v1`): an inclusion glob that
 * selects nothing, or a negation that excludes nothing.
 */
export interface ICoverageDeadGlob {
  /** The side-qualified label — identical to the rule's `deadGlobs` entry (`declared: src/moved/*.ts`). */
  readonly selector: string;
  /** The glob as written (a negation keeps its `!`). */
  readonly glob: string;
  readonly negation: boolean;
  /**
   * Why it is dead: `matched 0 files`, `matches only files the list's
   * negations exclude (N)`, or `excludes nothing — none of the N file(s) the
   * other globs select match it`.
   */
  readonly reason: string;
}
