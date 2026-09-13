/**
 * A built-in recommender recipe. `terms` and `phrases` go through THE term
 * matcher (tokens mode), so `pr` no longer fires inside "pricing" nor `pack`
 * inside "package". `regex` is kept only for phrase-shaped alternations, every
 * alternative anchored at a word boundary.
 */
export interface IRecommendRecipe {
  readonly id: string;
  readonly terms: readonly string[];
  readonly phrases?: readonly string[];
  readonly regex?: RegExp;
  readonly recommendations: readonly { readonly command: string; readonly why: string }[];
}
