import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IContributionFileReport } from './i-contribution-file-report.ts';

/**
 * THE contributions report (round 12, ONE-CHANGE): every contributed file —
 * local and pack — with entries accepted, entries rejected and references that
 * cannot be checked. Built from the contributions inventory, THE rejection
 * channel and the self-config doctor's own reference probes, so it adds no
 * parallel resolver.
 */
export interface IContributionsReport {
  readonly files: readonly IContributionFileReport[];
  readonly totals: Readonly<{
    files: number;
    declared: number;
    accepted: number;
    rejected: number;
    /** Files that failed to import. */
    loadFailed: number;
    /** Pack-declared files missing on disk. */
    missing: number;
    /** Declared reference ids that could not be checked. */
    unresolvable: number;
  }>;
  /**
   * THE coverage the verdict settles on: declared references probed vs those
   * that could be checked. Absent when no reference was probed (nothing to
   * examine is not a shortfall of THIS report).
   */
  readonly referenceCoverage?: IVerdictCoverage;
}
