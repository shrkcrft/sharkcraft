/**
 * What a rule whose primary selector yielded nothing IS — the answer
 * `settleRuleEmptiness` gives, for every plane.
 */
export enum RuleEmptiness {
  /** The rule extracted at least one unit: not empty, evaluate it normally. */
  Matched = 'matched',
  /** Nothing came out, but a matched file was not read: PARTIAL through the read scope, never empty. */
  Unread = 'unread',
  /**
   * The primary list matched no FILE, nothing was unread, and EVERY primary
   * inclusion unit is intended-empty: accepted (exit 0, printed). Never granted
   * for "0 units out of live files" — that is the stale-extractor loud skip.
   */
  IntendedEmpty = 'intended-empty',
  /** A baselines rule-level `expectEmpty` fence over live (or intended-empty) inputs: the empty output is the verified state. */
  AssertedEmptyOutput = 'asserted-empty-output',
  /** The primary list's own negations excluded every file its inclusion globs matched. Skipped. */
  EmptiedByNegations = 'emptied-by-negations',
  /** Nothing to accept: a loud skip (`failOnEmpty` → 1, else 2). `RuleEmptinessCause` says why. */
  Stale = 'stale',
}
