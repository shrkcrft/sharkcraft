import type { MatchConfidenceVerdict } from '@shrkcrft/core';
import type { RecommendationSource } from './recommendation-source.ts';
import type { IUncertaintySignalDetail } from './uncertainty-report.ts';

/**
 * `deriveRecommendationConfidence`'s answer — THE confidence for recommend,
 * MCP `recommend_commands` and `shrk context`, derived from the same scores
 * the list is ranked by. Carries the shared vocabulary (`confident`,
 * `verdict`, `floor`, `bestScore`) reuse and playbooks use too.
 */
export interface IRecommendationConfidence {
  /** Some eligible candidate from a counting source cleared the floor. */
  readonly confident: boolean;
  readonly verdict: MatchConfidenceVerdict;
  /** The floor multiplier, in normalised units (1.0 = each source's own floor). */
  readonly floor: number;
  /** The best eligible counting candidate's normalised score; 0 when there is none. */
  readonly bestScore: number;
  readonly bestSource?: RecommendationSource;
  readonly bestSourceId?: string;
  readonly level: 'high' | 'medium' | 'low' | 'unknown';
  readonly reasons: readonly string[];
  readonly missingSignals: readonly IUncertaintySignalDetail[];
  readonly conflictingSignals: readonly IUncertaintySignalDetail[];
  readonly whatWouldIncreaseConfidence: readonly string[];
  readonly warnings: readonly string[];
}
