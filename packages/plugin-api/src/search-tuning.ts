/**
 * Search tuning lets packs/local config bias SharkCraft's deterministic search
 * ranker. It NEVER filters results — only nudges scores. Boosts are capped to
 * keep tuning from dominating the natural signal.
 */
export interface ISearchTaskHint {
  /** Token list (lowercase) that must appear in the query for the hint to apply. */
  whenTokens?: readonly string[];
  boostTags?: Record<string, number>;
  boostKinds?: Record<string, number>;
  boostIds?: Record<string, number>;
}

export type SearchTuningMergeStrategy = 'sum' | 'max';

export interface ISearchTuning {
  id: string;
  /** When set, the tuning only applies to results in these kinds. */
  appliesToKinds?: readonly string[];
  /**
   * How this tuning composes with other tunings touching the same boost key.
   * - `sum` (default): each tuning's boost adds, then the global cap clips.
   * - `max`: when any tuning contributing to the key declares `max`, the
   *   combined boost is the strongest single contributor (by absolute value).
   *   Useful when packs ship overlapping bias rules and the user wants the
   *   single most-relevant one to win rather than stacking.
   */
  mergeStrategy?: SearchTuningMergeStrategy;
  boostTags?: Record<string, number>;
  boostIds?: Record<string, number>;
  boostSources?: Record<string, number>;
  taskHints?: readonly ISearchTaskHint[];
}

export function defineSearchTuning(input: ISearchTuning): ISearchTuning {
  return input;
}
