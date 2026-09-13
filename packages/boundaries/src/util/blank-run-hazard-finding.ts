/**
 * One blank-run backtracking hazard found in a regex source by
 * `findBlankRunHazards`.
 *
 * `leading`: an alternative can START a match at every offset of a blank run
 * and then consume the rest of the run — O(run²) per blanked comment/string.
 * `adjacent`: two whitespace-consuming quantifiers touch (only optional items
 * between them), so the engine re-partitions every run between them.
 */
export interface IBlankRunHazard {
  readonly shape: 'leading' | 'adjacent';
  /** Offset of the offending construct in the regex source. */
  readonly index: number;
  /** The offending slice of the source. */
  readonly fragment: string;
  /** One sentence: what backtracks, and why a blanked buffer makes it expensive. */
  readonly message: string;
  /**
   * The hazard's REACH: whether the flagged quantifier(s) consume newlines.
   *
   * A line-bounded hazard (`[ \t]*`, `.*?`, `[ ]*` — or an `adjacent` pair
   * overlapping only on spaces) re-scans at most to the end of its line, so
   * on a blanked buffer it costs Σ line-run², not Σ (multi-line run)². A
   * cost prediction that ignores this skips files the pattern would scan in
   * milliseconds.
   */
  readonly crossesNewline: boolean;
  /**
   * `leading` only: a match can start only at a LINE start (`(?:^|\n)\s*`),
   * so the cost is (lines × run), not run².
   */
  readonly fromLineStart?: boolean;
}
