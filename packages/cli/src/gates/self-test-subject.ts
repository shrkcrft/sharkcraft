/**
 * What a rule's primary selector resolved to, in the terms a `selfTest`
 * asserts on.
 *
 * Each plane's coverage adapter produces one, and `evaluateSelfTest` reads
 * nothing else. That is what keeps `gates coverage` and `gates try` from
 * disagreeing about whether an expectation held: they hand the same subject to
 * the same evaluator.
 */
export interface ISelfTestSubject {
  /** Every distinct id the selector extracted, sorted. */
  readonly ids: readonly string[];
  /** What `expectMatchesAtLeast` counts. */
  readonly unitsMatched: number;
  /** The unit {@link unitsMatched} counts — `ids`, `content units`, `generated files`. */
  readonly unitLabel: string;
  /** What one "id" is on this plane — `registry ids`, `pattern matches (capture group 1 …)`. */
  readonly idLabel: string;
  /** The selector consulted, e.g. `registry "mcp-tools" — source a/*.ts (regex-capture)`. */
  readonly consulted: string;
  /**
   * Set when this plane shape cannot produce the set a selfTest asserts on (a
   * `command` baseline with no `watchFiles` to probe): the reason, printed
   * instead of a fabricated "got 0".
   */
  readonly notEvaluable?: string;
}
