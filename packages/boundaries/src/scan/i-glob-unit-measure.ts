/**
 * What ONE glob of a list did to a set of paths (`measureGlobList`).
 *
 * An inclusion glob's `effective` count is the paths it matched that SURVIVE
 * the list's negations; a negation's is the paths it REMOVED from what the
 * list's inclusion globs selected. So "is this unit live?" is `effective > 0`
 * for both kinds, and a negation is never "dead" merely for matching no path
 * on its own — a negation matches nothing by itself; it subtracts.
 */
export interface IGlobUnitMeasure {
  /** The glob as written (a negation keeps its `!`). */
  readonly glob: string;
  readonly negation: boolean;
  /**
   * Inclusion glob: every path it matches. Negation: every path it matches
   * among those the list's inclusion globs select (its raw reach).
   */
  readonly matched: number;
  /** Inclusion glob: matched paths that are selected. Negation: paths it excludes. */
  readonly effective: number;
}
