/**
 * The flags an asset doctor's proposal reads (round 13) — `registrations
 * doctor`, `scaffolds doctor`, `search tuning doctor`, `self-config
 * doctor|report` and their MCP twins (which pass both `false`).
 */
export interface IAssetDoctorFlags {
  /**
   * `--strict`: a warning issue fails (1). It never promotes a went-live
   * `expectEmpty` marker — only `check boundaries`, where `--strict` is already
   * the warning promoter for selector units, does that.
   */
  readonly strict: boolean;
  /** `--fail-on-dead-units`: a dead selector unit, or a stale LOCAL `expectEmpty` marker, fails (1). */
  readonly failOnDeadUnits: boolean;
}
