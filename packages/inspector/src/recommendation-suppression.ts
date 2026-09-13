/**
 * Why a candidate is kept OUT of the recommendation list. A suppressed row
 * stays in the report's `ranked` list with its reason and is counted in one
 * printed line — suppression is never silent.
 */
export enum RecommendationSuppression {
  /** Writes source, and the query is not create/build work (`recommend.scaffoldRequiresCreateIntent`). */
  NonCreateIntent = 'non-create-intent',
  /** A ranker match sharing fewer than 2 distinct terms with the query — one incidental word is not evidence. */
  SingleIncidentalTerm = 'single-incidental-term',
  /** Writes source while nothing is confident, or below its own floor — never a low-confidence headline. */
  BelowFloor = 'below-floor',
}
