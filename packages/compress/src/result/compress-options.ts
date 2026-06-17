import type { EContentType } from '../content/content-type.ts';
import type { ICcrStore } from '../ccr/ccr-store.ts';

/**
 * Knobs for a compression pass. All optional — the defaults produce a safe,
 * deterministic reduction. `store` is what makes a lossy pass reversible: when
 * present, the original is cached and a `<<ccr:…>>` marker is appended.
 */
export interface ICompressOptions {
  /** Cache originals here so lossy output stays retrievable (CCR). */
  store?: ICcrStore;
  /** Task / query text that biases which lines or matches are kept. */
  query?: string;
  /** Force a content class instead of auto-detecting. */
  contentType?: EContentType;
  /** Soft cap on retained items/lines/matches/hunks (compressor-specific). */
  maxItems?: number;
  /** Below this many lines a lossy text pass returns the input untouched. */
  minLines?: number;
  /**
   * Token budget for a JSON array. When set and the lossless columnar form
   * still exceeds it, `compressJson` falls back to the lossy SmartCrusher
   * row-sampler (kept rows + CCR original). Without it, JSON stays lossless.
   */
  maxTokens?: number;
}
