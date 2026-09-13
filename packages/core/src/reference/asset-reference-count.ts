import type { IWiringSource } from '../wiring/wiring-rule.ts';

/**
 * A number an asset claims, declared so the tooling can RE-DERIVE it.
 *
 * Counts are the fastest-rotting claims in a corpus — "N implementations
 * extend this base", "the closed set has N members" — because ordinary feature
 * work changes them and nothing reads the prose. This pins the claim to an
 * extraction-DSL source (the same `IWiringSource` every gate plane uses), so it
 * is measured by the ONE extraction authority (`inspectSource`) and inherits
 * its scan zones, extractors and globs rather than growing a second parser.
 */
export interface IAssetReferenceCount {
  /** What to measure — any extraction-DSL source (`$use` is not accepted here). */
  readonly source: IWiringSource;
  /** The number the asset claims. A non-negative integer. */
  readonly expected: number;
  /**
   * `ids` (default): distinct extracted ids. `sites`: every capture site, so a
   * token that appears twice counts twice.
   */
  readonly measure?: 'sites' | 'ids';
}
