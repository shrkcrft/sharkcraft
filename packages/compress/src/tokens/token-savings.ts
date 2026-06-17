/**
 * Token-accounting summary for a compression pass. Every compressor in this
 * package reports its effect through this shape so savings are measured, not
 * assumed.
 */
export interface ITokenSavings {
  /** Estimated tokens of the input. */
  before: number;
  /** Estimated tokens of the output. */
  after: number;
  /** `before - after` (never negative; clamped at 0). */
  saved: number;
  /**
   * Fraction saved in `[0, 1]`, rounded to 4 dp. `0` when the input was
   * empty or the output grew (a compressor must never be reported as a
   * net loss).
   */
  ratio: number;
}
