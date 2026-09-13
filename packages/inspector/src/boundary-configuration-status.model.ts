/**
 * The ONE answer to "are boundary rules configured, and if not, why?"
 * (round 11, L-1).
 *
 * Five surfaces answered this differently — `check boundaries` said "no rules
 * configured" and exited 0 while telling the author to create a file that
 * already existed (it was simply not listed in `boundaryFiles`), quality said
 * `passed`, finish said `skipped`, MCP returned a count and no verdict. Every
 * surface now renders these diagnostics.
 */
export interface IBoundaryConfigurationStatus {
  /** Rules in the registry (local + pack). */
  readonly ruleCount: number;
  /** `ruleCount > 0`. */
  readonly configured: boolean;
  /** Where the sharkcraft directory resolved — printed so a wrong root is visible. */
  readonly sharkcraftDir: string | null;
  readonly configFile: string | null;
  /** The config exists but failed to load — no `boundaryFiles` could be read. */
  readonly configInvalid: boolean;
  /** `boundaryFiles` entries as written (relative to the sharkcraft dir). */
  readonly listedLocalFiles: readonly string[];
  /** Listed entries whose file does not exist (absolute paths). */
  readonly missingListedFiles: readonly string[];
  /** `sharkcraft/boundaries.ts` exists but is NOT listed, so it loads nothing (absolute path). */
  readonly unlistedDefaultFile?: string;
  /** Boundary files contributed by packs. */
  readonly packBoundaryFiles: readonly { readonly packageName: string; readonly file: string }[];
  /** Rules / files that failed to load (see `IBoundaryLoadIssue`). */
  readonly loadIssues: number;
  /** Human sentences explaining the state, most actionable first. */
  readonly diagnostics: readonly string[];
}
