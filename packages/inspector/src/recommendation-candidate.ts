import type { RecommendationSource } from './recommendation-source.ts';
import type { RecommendationSuppression } from './recommendation-suppression.ts';

/** One candidate command in THE recommendation ranking. */
export interface IRecommendationCandidate {
  readonly command: string;
  readonly why: string;
  readonly safetyLevel: 'read-only' | 'writes-drafts' | 'writes-session' | 'writes-source' | 'runs-shell';
  readonly source: RecommendationSource;
  /** Hint id, recipe id, template/pipeline id, diagnostic code, plan verb, or change-intent kind. */
  readonly sourceId?: string;
  /** The source's own score (hint score, rankAll score, 2 × recipe terms, …). */
  readonly rawScore: number;
  /** The source's own floor (`RECOMMEND_SOURCE_FLOORS`). */
  readonly sourceFloor: number;
  /** rawScore / sourceFloor, 2 decimals: 1.0 = "just strong enough" for any source. */
  readonly normalisedScore: number;
  /** The evidence: matched query terms (ranker, recipe) or hint reasons. */
  readonly matchedTerms: readonly string[];
  readonly writesSource: boolean;
  /** Below the confidence floor — a guess, never a route. */
  readonly weak: boolean;
  /** Set when the candidate is kept out of the list (see {@link RecommendationSuppression}). */
  readonly suppressedReason?: RecommendationSuppression;
  /** One-line attribution, e.g. `routing hint "billing-refactor" (score 7, floor 3)`. */
  readonly attribution: string;
  /** Attributions of other sources that proposed the same command (deduped into this row). */
  readonly alsoProposedBy?: readonly string[];
  readonly docsLink?: string;
}
