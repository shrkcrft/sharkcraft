/**
 * A glob list split into what it SELECTS and what it SUBTRACTS.
 *
 * On every gate plane a path is selected by a list iff one of its `include`
 * globs matches and none of its `exclude` globs does. The subtraction is
 * order-independent (not gitignore-ordered: a later glob never re-includes)
 * and applies to its OWN list only — one rule's `!x` never removes a file from
 * another rule's scope. `parseGlobList` is the one parser that produces this.
 */
export interface IGlobList {
  /** The inclusion globs, as written. */
  readonly include: readonly string[];
  /** The negations, stored WITHOUT their leading `!`. */
  readonly exclude: readonly string[];
}
