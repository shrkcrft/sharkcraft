/**
 * How one doctor run settles — THE reading of an `IDoctorResult` that every
 * surface shares (`shrk doctor`, `shrk check`, the dashboard, MCP
 * `inspect_sharkcraft_setup`), so none of them can call a setup ready that
 * another calls not verified.
 */
export enum DoctorVerdictKind {
  /** No error check, and every scope the doctor was asked to verify was verified. */
  Ready = 'ready',
  /**
   * No error check, but part of the setup could not be verified (today: a
   * compiled pack build with no build record, never compared with its
   * source). Never "ready".
   */
  NotVerified = 'not-verified',
  /** At least one error-severity check. */
  Errors = 'errors',
}
