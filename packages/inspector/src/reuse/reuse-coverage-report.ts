import type { IUnfollowedReExport, ReuseMatchSource, ReuseNameMatch } from '@shrkcrft/core';
import type { IReuseCuratedCoverage } from './reuse-curated-coverage.ts';

/**
 * Curated reuse index vs the real public export surface — the numbers that make
 * curation drift measurable instead of silent (`shrk reuse coverage`).
 */
export interface IReuseCoverageReport {
  /** Every in-scope curated entry, in config order. */
  readonly curated: readonly IReuseCuratedCoverage[];
  /** Curated entries a `--package` narrowing excluded (deliberate, not a gap). */
  readonly curatedOutOfScope: number;
  readonly surface: {
    readonly roots: readonly { readonly package: string; readonly dir: string; readonly entryFile: string }[];
    /** In-scope packages whose exports were NOT measured, each with why. */
    readonly packagesWithoutEntry: readonly { readonly package: string; readonly dir: string; readonly reason: string }[];
    /** Public exports in scope (per package × name). */
    readonly all: number;
    /** Public exports that are not type-level (everything but interfaces / type aliases). */
    readonly value: number;
    readonly byKind: Readonly<Record<string, number>>;
    /** In-scope re-exports not followed to a declaration (`unfollowedReExports.length`). */
    readonly unresolvedReExports: number;
    /**
     * Each of them, classified. An `unresolved` one is part of its package's
     * surface that was NOT measured; an `external` one leaves the workspace.
     */
    readonly unfollowedReExports: readonly IUnfollowedReExport[];
  };
  /** In-scope curated entries on the public surface. */
  readonly curatedPublic: number;
  /** …of which the public construct is not type-level. */
  readonly curatedPublicValue: number;
  /** curatedPublicValue / value — the primary ratio. Absent when value is 0. */
  readonly ratioValue?: number;
  /** curatedPublic / all. Absent when all is 0. */
  readonly ratioAll?: number;
  /** Public exports no curated entry names or supersedes (capped; see uncoveredTotal). */
  readonly uncovered: readonly {
    readonly name: string;
    readonly package: string;
    readonly declaredIn: string;
    readonly declKind: string;
  }[];
  readonly uncoveredTotal: number;
  /**
   * Curation gaps: an uncovered export whose own name, asked as an intent,
   * gets a DIFFERENT curated answer from the reuse lookup — the lookup's own
   * ranker, curated-only, so this list and `shrk reuse --curated-only` cannot
   * disagree.
   */
  readonly shadowed: readonly {
    readonly export: string;
    readonly package: string;
    readonly declaredIn: string;
    readonly answeredBy: string;
    readonly matchedVia: readonly ReuseMatchSource[];
    readonly nameMatch: ReuseNameMatch;
  }[];
  /** Public exports a curated entry deliberately `supersedes` — covered by intent. */
  readonly superseded: readonly {
    readonly export: string;
    readonly package: string;
    readonly supersededBy: readonly string[];
  }[];
}
