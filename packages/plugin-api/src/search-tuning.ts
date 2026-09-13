/**
 * Search tuning lets packs/local config bias SharkCraft's deterministic search
 * ranker. It NEVER filters results — only nudges scores. Boosts are capped to
 * keep tuning from dominating the natural signal.
 *
 * Intended-empty boosts (round 13, docs/intended-empty.md): a `boostIds` /
 * `taskHints[].boostIds` VALUE may be `{ weight, expectEmpty: true, reason? }`
 * — a boost for a document that does not exist yet (a pack boosting the guide
 * an adopting app will write). The unit is the map KEY. The loader normalises
 * the value to its weight plus an `expectEmptyUnits` ledger (it is never
 * clamped to 0); `search tuning doctor` accepts a marked missing target
 * (printed) and reports it as went-live once the target is registered. Only a
 * missing target can be marked: an unprefixed, unknown-kind or
 * `appliesToKinds`-excluded key can never fire, so a marker on it is refused.
 * Needs engine 0.1.0-alpha.31 or later.
 */
import type { IUnitMark, SelectorWeightEntry } from '@shrkcrft/core';

export interface ISearchTaskHint {
  /** Token list (lowercase) that must appear in the query for the hint to apply. */
  whenTokens?: readonly string[];
  boostTags?: Record<string, number>;
  boostKinds?: Record<string, number>;
  boostIds?: Record<string, number>;
}

/** An AUTHORED task hint: `boostIds` values may be `{ weight, expectEmpty: true, reason? }` markers. */
export interface ISearchTaskHintInput extends Omit<ISearchTaskHint, 'boostIds'> {
  boostIds?: Record<string, SelectorWeightEntry>;
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
  /**
   * LOADED tuning only (round 13): the boost keys marked `expectEmpty` (`list`
   * = `boostIds` / `taskHints[<i>].boostIds`, `unit` = the key), stamped with
   * the contributing pack by the loader. Derived — an author never writes it
   * (the loader refuses the key); write `{ weight, expectEmpty: true }` instead.
   */
  expectEmptyUnits?: readonly IUnitMark[];
}

/** An AUTHORED search-tuning entry: markable `boostIds` / `taskHints[].boostIds` values. */
export interface ISearchTuningInput extends Omit<ISearchTuning, 'boostIds' | 'taskHints' | 'expectEmptyUnits'> {
  boostIds?: Record<string, SelectorWeightEntry>;
  taskHints?: readonly ISearchTaskHintInput[];
}

/** Author one search-tuning entry (weight markers allowed in the id boost maps); returns it unchanged. */
export function defineSearchTuning<T extends ISearchTuningInput>(input: T): T {
  return input;
}
