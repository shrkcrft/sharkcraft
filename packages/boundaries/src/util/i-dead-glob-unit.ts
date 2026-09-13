/**
 * One glob of a gate-plane list that does nothing (`globListUnits`).
 *
 * An inclusion glob is dead when it selects nothing that survives the list's
 * negations; a negation is dead when it EXCLUDES nothing from its own list's
 * positive set. The `reason` says which, in the words every surface prints.
 */
export interface IDeadGlobUnit {
  /** The glob as written (a negation keeps its `!`). */
  readonly glob: string;
  readonly negation: boolean;
  /**
   * Inclusion glob: the files it matched before the list's negations (0, or
   * all of them excluded). Negation: the size of the positive set it failed to
   * touch.
   */
  readonly matched: number;
  /**
   * `matched 0 files`, `matches only files the list's negations exclude (N)`,
   * or `excludes nothing — none of the N file(s) the other globs select match it`.
   */
  readonly reason: string;
}
