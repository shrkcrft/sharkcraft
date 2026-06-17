import type { EContentType } from '../content/content-type.ts';
import type { ECompressionStrategy } from './compression-strategy.ts';
import type { ITokenSavings } from '../tokens/token-savings.ts';

/**
 * The outcome of compressing one blob. `compressed` is always safe to hand to
 * a model as-is. When a lossy strategy dropped detail, `ccrKey` points at the
 * cached original so the agent can call `retrieve_original` / `shrk expand`
 * to get it back (Compress-Cache-Retrieve).
 */
export interface ICompressionResult {
  /** The compressed text, ready for the model. */
  compressed: string;
  /** Detected (or caller-forced) content class. */
  contentType: EContentType;
  /** Strategy that produced `compressed`. */
  strategy: ECompressionStrategy;
  /** Token accounting for the pass. */
  savings: ITokenSavings;
  /** True when detail was dropped (and an original was cached, if a store was given). */
  lossy: boolean;
  /** CCR key for the cached original, when a lossy pass stored one. */
  ccrKey?: string;
  /** A one-line, human/agent-readable note about what happened. */
  note: string;
}
