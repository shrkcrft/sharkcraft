import type { IRejectedEntry, IVerdictCoverage } from '@shrkcrft/core';
import type {
  IScaffoldPatternCoverage,
  IScaffoldPatternIssue,
  IScaffoldPatternWithSource,
  scaffoldPatternCoverage,
} from './scaffold-patterns.ts';

/**
 * THE scaffold-pattern doctor's findings (`buildScaffoldPatternDoctorReport`)
 * — what `shrk scaffolds doctor` and MCP `get_scaffold_pattern_doctor` both
 * render and settle (round 13), so the two cannot disagree.
 */
export interface IScaffoldPatternDoctorReport {
  /** Every accepted pattern (loaded, normalised; a pack's markers stamped). */
  readonly patterns: readonly IScaffoldPatternWithSource[];
  /** FILE-level load problems (missing, not an array, failed to import). */
  readonly loadWarnings: readonly string[];
  /** Every pattern its loader REFUSED (THE rejection channel) — each counts as an error. */
  readonly rejected: readonly IRejectedEntry[];
  /** The definition checks plus the per-unit findings, from THE settles. */
  readonly issues: readonly IScaffoldPatternIssue[];
  /** Error issues plus refused entries. */
  readonly errors: number;
  readonly warnings: number;
  /** THE settles over the enumeration (`scaffoldPatternCoverage`): their coverage, unmarked dead list and units. */
  readonly measured: ReturnType<typeof scaffoldPatternCoverage>;
  /**
   * The verdict's coverage: `measured.coverage`, plus — over zero patterns — a
   * "nothing declared" record (NOT VERIFIED unless the empty acceptance the
   * caller passed accepts it, printed).
   */
  readonly coverage: readonly IVerdictCoverage[];
  /** Per pattern: files matched after `excludePaths`, and per `matchPaths` glob — for `--json`. */
  readonly patternCoverage: readonly {
    readonly patternId: string;
    readonly files: number;
    readonly perMatchPath: IScaffoldPatternCoverage['perMatchPath'];
  }[];
}
