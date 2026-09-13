import type { KnowledgeClaimField } from '../model/knowledge-claim-field.ts';

/**
 * One declared reference or anchor — or a whole non-list value — that is not a
 * well-typed object: listed with why, never dropped from a listing.
 */
export interface IMalformedKnowledgeClaim {
  /** The field it was declared under. */
  readonly field: KnowledgeClaimField;
  /**
   * 1-based position in the list — the `reference #N` / `anchor #N` that
   * `shrk doctor` names. Absent when the whole value is not a list.
   */
  readonly position?: number;
  /** The value as declared. */
  readonly value: unknown;
  /** Why it is not usable — the wording `shrk doctor` prints for it. */
  readonly problem: string;
}
