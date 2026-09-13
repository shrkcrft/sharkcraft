/**
 * Which signal proposed a recommendation. Every candidate in THE ranked list
 * carries one, so a headline row is always attributable, and ties break on
 * this precedence: project data (diagnostic, routing hint, ranker) beats the
 * engine's built-in recipes and the intent fallback.
 */
export enum RecommendationSource {
  /** A `--from-error` stderr blob matched a known diagnostic. */
  Diagnostic = 'diagnostic',
  /** The query reads as planning: `shrk grounding` is pinned first (never counts toward confidence). */
  Planning = 'planning',
  /** A project/pack task-routing hint matched; one row per `recommends.commands` entry. */
  RoutingHint = 'routing-hint',
  /** The shared ranker's top template (`shrk gen <template>`). */
  RankerTemplate = 'ranker-template',
  /** The shared ranker's top pipeline (`shrk task "<query>"`). */
  RankerPipeline = 'ranker-pipeline',
  /** A built-in keyword recipe. */
  Recipe = 'recipe',
  /** change-intent's suggested first command — always below the floor. */
  IntentFallback = 'intent-fallback',
}
