import type { MatchConfidenceVerdict } from '@shrkcrft/core';
import type { IReuseCandidate } from './reuse-candidate.ts';
import type { IReuseSuggestion } from './reuse-suggestion.ts';

/** The reuse engine's answer to one intent. */
export interface IReuseRanking {
  /** The normalised intent tokens every score is computed over. */
  readonly tokens: readonly string[];
  /** Shared confidence vocabulary: at least one candidate cleared the floor. */
  readonly confident: boolean;
  readonly verdict: MatchConfidenceVerdict;
  /** Distinct intent tokens a metadata-only match must hit (a name match always clears it). */
  readonly floor: number;
  /** Best score among results and suggestions; 0 when nothing shares a term. */
  readonly bestScore: number;
  /** Confident answers, tier-ordered, capped at the limit. */
  readonly results: readonly IReuseCandidate[];
  /** Weak did-you-mean rows — only when `results` is empty. */
  readonly suggestions: readonly IReuseSuggestion[];
  /** Exports that matched by name but a curated entry's `supersedes` steers away from. */
  readonly superseded: readonly {
    readonly symbol: string;
    readonly package: string;
    readonly supersededBy: readonly string[];
  }[];
  /**
   * An uncurated export answers by name (exact / covers) while the best curated
   * candidate names it only in part, or matched only through metadata — the
   * curated index does not cover this intent. `isReuseCurationGap`, the same
   * predicate `shrk reuse coverage` lists `shadowed` by.
   */
  readonly curationGap: boolean;
  /** Some candidate matched by NAME (tiers 1–3). False is the miss path. */
  readonly nameAnswered: boolean;
  /** The export surface was searched (a surface was given and not curated-only). */
  readonly surfaceSearched: boolean;
}
