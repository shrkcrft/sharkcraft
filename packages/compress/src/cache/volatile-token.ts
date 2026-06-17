import type { EVolatileKind } from './volatile-kind.ts';

/**
 * An aggregated volatile-token finding: how many times a kind of cache-busting
 * token appears, plus one representative sample (truncated). Detection only —
 * the prompt is never mutated.
 */
export interface IVolatileToken {
  kind: EVolatileKind;
  /** Number of occurrences in the scanned text. */
  count: number;
  /** A representative occurrence (first seen), truncated to 24 chars. */
  sample: string;
}
