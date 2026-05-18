export enum DoctorSeverity {
  Ok = 'ok',
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface IDoctorCheck {
  id: string;
  title: string;
  severity: DoctorSeverity;
  message: string;
  fix?: string;
  /**
   * Optional warning-quality fields. Backwards compatible: every
   * field is optional and existing checks render unchanged when absent.
   *
   *   - `category`: stable bucket (e.g. `action-hint-quality`,
   *     `pack-doctor`, `boundary`). Used by `--hide` and acknowledgements.
   *   - `code`: stable per-finding code (e.g. `missing-verification`).
   *     Distinguishes related findings inside the same category.
   *   - `recommendedFix`: a copy-pasteable command that addresses the
   *     finding (e.g. `shrk fix preview --action-hints --target <id>`).
   *   - `whyThisMatters`: a one-line explanation of the consequence of
   *     ignoring the finding. Designed to fight "permanent yellow noise".
   *   - `advisory`: true if the finding is for an advisory rule and
   *     should be presented as informational rather than actionable.
   */
  category?: string;
  code?: string;
  recommendedFix?: string;
  whyThisMatters?: string;
  advisory?: boolean;
}

export interface IDoctorResult {
  passed: boolean;
  checks: readonly IDoctorCheck[];
  summary: {
    ok: number;
    info: number;
    warnings: number;
    errors: number;
    /**
     * Count of checks marked `advisory: true` OR `severity: info`.
     * These are the findings the default text render collapses behind
     * `--show-advisory`. JSON consumers see the same count
     * here without needing to re-derive it from `checks[]`.
     */
    advisoryCount?: number;
  };
}
