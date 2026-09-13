/**
 * One failing reference / anchor / entry in a knowledge stale-check rule —
 * structurally the CLI gate envelope's `IGateViolation`, so the verb hands the
 * rule to `buildGateEnvelope` unchanged.
 */
export interface IKnowledgeStaleGateViolation {
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
  readonly hint?: string;
}
