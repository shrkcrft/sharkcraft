/** Per-reference-kind outcome counts of a staleness sweep (`file`, `symbol`, `template`, …). */
export interface IKnowledgeReferenceKindBucket {
  checked: number;
  ok: number;
  stale: number;
  missing: number;
  unknown: number;
  /** Malformed references of this kind (a missing required field) — never checked. */
  invalid: number;
}
