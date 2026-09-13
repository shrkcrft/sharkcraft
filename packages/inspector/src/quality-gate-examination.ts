/**
 * How one quality gate's run counts toward the quality report's coverage —
 * THE classification behind `IQualityReport.overall` and `shrk quality`'s item
 * status, so the MCP / dashboard / report-site verdict and the CLI verdict
 * cannot disagree about a gate.
 */
export enum QualityGateExamination {
  /** It ran over its whole scope: its `passed` is a verdict. */
  Examined = 'examined',
  /** It examined nothing and was optional: a deliberate skip, never counted as a pass. */
  DeliberateSkip = 'deliberate-skip',
  /** It could not run, examined nothing while required, or examined only part of its scope. */
  Unexamined = 'unexamined',
}
