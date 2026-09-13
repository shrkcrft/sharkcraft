/**
 * Where an `appliesTo` filter is decided (round 15, 15.1) — see
 * `conventionApplicability`.
 */
export enum ConventionFilterLevel {
  /** Decided once per workspace, from what the workspace detectors saw (`profileIds`, `frameworks`). */
  Workspace = 'workspace',
  /** Decided per file (`fileGlobs`, `languages`). */
  File = 'file',
  /** Loaded and never evaluated — the convention applies regardless (`constructKinds`). */
  Reserved = 'reserved',
}
