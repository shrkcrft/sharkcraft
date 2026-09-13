/**
 * Per-kind counts of a staleness sweep — by asset kind (knowledge / boundary
 * rule / policy) and by knowledge entry `type`.
 *
 * `scanned: 0` means the kind was NOT IN THE SWEEP, which a renderer must say
 * in words — a row of zeros cannot tell "clean" from "never looked".
 */
export interface IKnowledgeKindBucket {
  /** Subjects of this kind the sweep visited. */
  scanned: number;
  /** Of those, how many declare no references / anchors at all. */
  zeroReferences: number;
  /** References + anchors checked for this kind. */
  referencesChecked: number;
  verified: number;
  stale: number;
  unverifiable: number;
}
