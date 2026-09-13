/** The run's flags, as `selectorUnitFails` reads them — every field REQUIRED so each surface states them. */
export interface ISelectorUnitFailOptions {
  /** `--fail-on-dead-units` (or the MCP `failOnDeadUnits` input). */
  readonly failOnDeadUnits: boolean;
  /** `--strict`. */
  readonly strict: boolean;
  /**
   * True only on a surface where `--strict` is ALREADY the warning promoter for
   * selector units (`check boundaries`). Elsewhere `--strict` never turns a
   * went-live marker into a failure.
   */
  readonly strictPromotesWarnings: boolean;
}
