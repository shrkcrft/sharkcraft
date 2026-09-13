import type {
  IPublicExport,
  IReusePrimitive,
  ReuseCandidateSource,
  ReuseMatchSource,
  ReuseNameMatch,
} from '@shrkcrft/core';

/** One confident reuse answer, before the CLI enriches it with graph detail. */
export interface IReuseCandidate {
  readonly symbol: string;
  readonly source: ReuseCandidateSource;
  /**
   * Ranking tier (lower wins):
   *   1 — curated, its NAME answers the intent (exact / covers);
   *   2 — uncurated, exact name match;
   *   3 — uncurated, the name covers every intent token;
   *   4 — curated, its name matches only PART of the intent, or it matched
   *       only through roles / keywords / description.
   * A curated entry that names the construct stays authoritative over an
   * uncurated one; an exactly-named export beats a curated hit that shares
   * one token of its name, or none.
   */
  readonly tier: number;
  readonly score: number;
  /** Fraction of distinct intent tokens that hit (0..1). */
  readonly confidence: number;
  readonly matched: readonly string[];
  readonly matchedVia: readonly ReuseMatchSource[];
  readonly nameMatch: ReuseNameMatch;
  /** Set for `curated` candidates. */
  readonly primitive?: IReusePrimitive;
  /** Set for `export-surface` candidates. */
  readonly export?: IPublicExport;
}
