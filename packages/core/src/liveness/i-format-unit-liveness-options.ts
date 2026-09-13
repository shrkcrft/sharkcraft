/** How `formatUnitLiveness` decorates the one per-unit line. */
export interface IFormatUnitLivenessOptions {
  /**
   * Prefix the list (`forbiddenImports: @scope/x — …`) — for JSON and for a
   * surface that does not already bracket it. Never doubled: a unit whose label
   * is already qualified (a custom `label`, or `<list>: <unit>`) is printed as is.
   */
  readonly list?: boolean;
  /**
   * Append `DEAD_SELECTOR_CAUSES` to an unmarked dead unit's line (default
   * true). A surface that prints the causes once as a footer passes false. A
   * unit dead by shape (`cause`) never gets them — it is not a typo.
   */
  readonly causes?: boolean;
}
