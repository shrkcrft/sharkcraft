/**
 * The three entry buckets of a staleness sweep, over the entries in scope.
 *
 * `verified + stale + unverifiable === entriesInScope`, always. The CLI renders
 * the unverifiable count AND its percentage on the summary line where a bare
 * `0 stale` used to sit, and turns {@link referencedRatio} into the verdict's
 * coverage (`examined` = verified + stale).
 */
export interface IKnowledgeStaleCoverage {
  readonly entriesInScope: number;
  readonly verified: number;
  readonly stale: number;
  readonly unverifiable: number;
  /** `unverifiable / entriesInScope × 100`, one decimal place; 0 for an empty scope. */
  readonly unverifiablePct: number;
  /** `(verified + stale) / entriesInScope` — the share the check could examine; 0 for an empty scope. */
  readonly referencedRatio: number;
}
