import type { ReuseCandidateSource, ReuseMatchSource, ReuseNameMatch } from '@shrkcrft/core';

/** A weak (below-confidence) candidate offered as a did-you-mean, never as an answer. */
export interface IReuseSuggestion {
  readonly symbol: string;
  readonly score: number;
  /** Fraction of distinct intent tokens that hit (0..1). */
  readonly confidence: number;
  readonly matched: readonly string[];
  /** Curated roles; `[]` for an uncurated export-surface suggestion. */
  readonly roles: readonly string[];
  readonly source: ReuseCandidateSource;
  readonly nameMatch: ReuseNameMatch;
  readonly matchedVia: readonly ReuseMatchSource[];
  /** Export-surface suggestions: the package that exposes it. */
  readonly package?: string;
  /** Export-surface suggestions: the declaring file. */
  readonly declaredIn?: string;
}
