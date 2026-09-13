import type { ISettledUnitLiveness, IVerdictCoverage } from '@shrkcrft/core';
import type { ISearchTuningKeyProbe } from './i-search-tuning-key-probe.ts';
import type { ISearchTuningLintIssue } from './i-search-tuning-lint-issue.ts';

/** What {@link lintSearchTuning} found over every loaded search-tuning entry. */
export interface ISearchTuningLintReport {
  readonly entries: number;
  readonly issues: readonly ISearchTuningLintIssue[];
  /**
   * Distinct boost keys probed, by resolution status — printed on one line, so
   * a 100% failure rate reads as a probe fault rather than N content errors.
   */
  readonly probes: Readonly<{
    probed: number;
    resolved: number;
    missing: number;
    unprefixed: number;
    unknownKind: number;
    unverified: number;
  }>;
  /**
   * Per-unit coverage, from THE settles (round 13): `boost keys` (live =
   * resolves AND admitted by an entry's `appliesToKinds`; a marked missing
   * target is its own printed `acceptedBy: expectEmpty` record) and `task hints`
   * (reachable triggers). A dead or unverifiable unit is a shortfall, so a
   * verdict can never pass over it.
   */
  readonly coverage: readonly IVerdictCoverage[];
  /** Every UNMARKED dead unit (never fires), labelled — THE settles' `dead`. */
  readonly deadUnits: readonly string[];
  /**
   * THE settles (round 13): boost keys, then task hints — each unit's state and
   * marker, what `--fail-on-dead-units` decides on (`selectorUnitFails`).
   */
  readonly liveness: readonly ISettledUnitLiveness[];
  /** THE key probes the lint judged (`searchTuningKeyProbes`) — the unresolvable-reference scan reads them. */
  readonly keyProbes: readonly ISearchTuningKeyProbe[];
}
