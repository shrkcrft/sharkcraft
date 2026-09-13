/**
 * One entry's verdict in the staleness sweep — three buckets, never one.
 *
 * The sweep used to report only reference-level counts, so an entry that
 * declared NO references contributed nothing and was folded into the healthy
 * total: the less verifiable a corpus was, the healthier it looked. An entry
 * the check could not examine is its own bucket, reported with its id.
 */
export enum KnowledgeEntryVerdict {
  /** At least one reference / anchor was checked, and every checked one resolved. */
  Verified = 'verified',
  /** At least one checked reference / anchor did not resolve. */
  Stale = 'stale',
  /** Nothing about this entry could be checked — see its reason. */
  Unverifiable = 'unverifiable',
}
