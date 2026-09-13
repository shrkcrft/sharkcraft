import type { QueryIntent } from './query-intent-kind.ts';

/** `classifyQueryIntent`'s answer. */
export interface IQueryIntentResult {
  /** The primary intent. */
  readonly intent: QueryIntent;
  /**
   * The create verb that makes this a create/build query, when one does —
   * set even when a planning verb earlier in the query makes the primary
   * intent `Plan` ("plan to add …").
   */
  readonly createVerb?: string;
  /** A planning verb in the first four terms ("help me plan …"), when present. */
  readonly planVerb?: string;
  /**
   * A create word that was found but does NOT make this a create query,
   * because a repair/diagnosis marker is present ("fix the broken BUILD",
   * "why does the NEW route fail") — names the marker.
   */
  readonly vetoedBy?: string;
  /** The normalised terms the decision was made over. */
  readonly terms: readonly string[];
}
