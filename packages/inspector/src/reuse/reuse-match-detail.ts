import type { ReuseMatchSource, ReuseNameMatch } from '@shrkcrft/core';

/** How one curated reuse primitive matched an intent — the evidence behind its score. */
export interface IReuseMatchDetail {
  /** +1 per distinct intent token that hit any field, +0.5 per role an intent token hit. */
  readonly score: number;
  /** The distinct intent tokens that hit — the evidence behind the score. */
  readonly matched: readonly string[];
  /** An intent token equals one of the symbol NAME's tokens (the strongest signal). */
  readonly symbolHit: boolean;
  /** Which fields the tokens hit, in fixed order symbol → role → keyword → description. */
  readonly matchedVia: readonly ReuseMatchSource[];
  /** The name-level match, by token equality. */
  readonly nameMatch: ReuseNameMatch;
}
