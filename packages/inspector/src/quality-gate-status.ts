/**
 * How one quality gate's ROW reads on every renderer (the dashboard, the HTML
 * report, the report site), derived once by `qualityGateStatus` from the one
 * classification (`examineQualityGate`). A gate that passed over part of its
 * scope is `not-verified`, never `pass` / `OK`.
 */
export enum QualityGateStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  /** It could not run, examined nothing while required, or examined only part of its scope. */
  NotVerified = 'not-verified',
  /** It examined nothing and was optional: a deliberate skip. */
  Skipped = 'skipped',
}
