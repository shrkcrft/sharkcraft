import type { IQueryIntentResult } from './query-intent-result.ts';
import type { IRecommendationCandidate } from './recommendation-candidate.ts';
import type { IRecommendationConfidence } from './recommendation-confidence.ts';
import type { ITaskRoutingMatchResult } from './task-routing-hint-registry.ts';

/**
 * THE ranked recommendation list. The recommend headline, `nextCommand`,
 * confidence and reasons, the CLI, MCP `recommend_commands` and
 * `shrk context` all derive from this one value.
 */
export interface IRankedRecommendations {
  readonly query: string;
  readonly intent: IQueryIntentResult;
  /** The floor multiplier in effect (CLI `--min-score` > MCP `minScore` > config `recommend.minScore` > 1). */
  readonly floor: number;
  /** Every candidate: the recommendations first (ranked), then the suppressed rows. */
  readonly candidates: readonly IRecommendationCandidate[];
  /** Eligible rows, deduped by command, ranked (a planning row is pinned first). */
  readonly recommendations: readonly IRecommendationCandidate[];
  readonly confidence: IRecommendationConfidence;
  /** Computed LAST, over `recommendations`: never a writes-source guess. */
  readonly nextCommand: string;
  /** The routing-hint matches the list was built from (`explainTaskRouting`). */
  readonly routingMatches: readonly ITaskRoutingMatchResult[];
  /** The shared ranker's raw top template / pipeline (null when the ranker did not run). */
  readonly rankerTop: {
    readonly topTemplate: { readonly id: string; readonly score: number } | null;
    readonly topPipeline: { readonly id: string; readonly score: number } | null;
  } | null;
}
