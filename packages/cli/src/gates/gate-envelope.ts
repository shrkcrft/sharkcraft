/**
 * One machine-readable shape for every gate verb.
 *
 * `--json` has always been available on each plane, but each emitted its own
 * schema (`sharkcraft.wiring/v1`, `sharkcraft.baseline/v1`, …), so a CI step or
 * agent had to parse four shapes to answer one question: which rules ran, which
 * failed, and why. This envelope is that answer, identical across planes.
 *
 * It is ADDITIVE. The per-plane payloads are published, documented, and asserted
 * by tests; replacing them would break every existing consumer. The envelope
 * rides along under a `gate` key, so `jq .gate` is the uniform read and nothing
 * that worked before stops working.
 */
export const GATE_ENVELOPE_SCHEMA = 'sharkcraft.gate/v1' as const;

/** Which data-defined plane produced a rule result. */
export type GateRuleType =
  | 'wiring'
  | 'policy'
  | 'registry'
  | 'registration'
  | 'baseline'
  | 'generated'
  | 'doc-reference';

/**
 * Per-rule outcome, uniform across planes. `skipped` is deliberately a
 * first-class status, not folded into `passed` — a rule that matched nothing
 * enforced nothing.
 */
export type GateRuleStatus = 'passed' | 'failed' | 'skipped' | 'error';

/** One violation, normalized. `id` is the offending token / entry / file. */
export interface IGateViolation {
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
  readonly message?: string;
  readonly hint?: string;
}

/** One rule's result in the shared envelope. */
export interface IGateRuleResult {
  readonly id: string;
  readonly type: GateRuleType;
  readonly status: GateRuleStatus;
  readonly severity: 'error' | 'warning';
  /**
   * Plane-appropriate match counts — e.g. `{declared, registered}` for wiring,
   * `{committed, current}` for baseline, `{units, findings}` for policy. Always
   * present so "what did this rule actually see?" is answerable uniformly.
   */
  readonly counts: Readonly<Record<string, number>>;
  readonly violations: readonly IGateViolation[];
  /** Why the rule checked nothing, when `status` is `skipped`. */
  readonly skipReason?: string;
  /** Set when the rule is misconfigured (`status: 'error'`). */
  readonly error?: string;
}

/** The envelope emitted under the `gate` key of every gate verb's `--json`. */
export interface IGateEnvelope {
  readonly schema: typeof GATE_ENVELOPE_SCHEMA;
  /** The verb that produced this, space-joined (e.g. `check wiring`). */
  readonly verb: string;
  /** The exit code this run returns — the same number the process exits with. */
  readonly exit: number;
  readonly rules: readonly IGateRuleResult[];
  /** Rules that ran a real comparison (status !== 'skipped'). */
  readonly evaluated: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Build the envelope from already-normalized per-rule results. */
export function buildGateEnvelope(
  verb: string,
  exit: number,
  rules: readonly IGateRuleResult[],
): IGateEnvelope {
  return {
    schema: GATE_ENVELOPE_SCHEMA,
    verb,
    exit,
    rules,
    evaluated: rules.filter((r) => r.status !== 'skipped').length,
    skipped: rules.filter((r) => r.status === 'skipped').length,
    failed: rules.filter((r) => r.status === 'failed' || r.status === 'error').length,
  };
}
