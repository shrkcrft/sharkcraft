import type { IVerdictCoverage } from '@shrkcrft/core';

export const QUALITY_GATE_SCHEMA = 'sharkcraft.quality-gate-report/v1' as const;

export type GateStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface IGateResult {
  /** Stable id (e.g. 'graph-fresh', 'arch', 'impact'). */
  id: string;
  /** Display label. */
  label: string;
  status: GateStatus;
  /** Short human-readable headline. */
  message: string;
  /** Optional details a renderer can use (counts, severity, etc.). */
  details?: Readonly<Record<string, unknown>>;
  /** Suggested follow-up command(s) the human / agent can run. */
  nextCommands?: readonly string[];
  /**
   * What the gate examined against what it was asked to — one record per unit
   * of work (e.g. per wiring rule, `subject` = the rule id). A gate that found
   * nothing wrong over a record with a coverage shortfall is NOT VERIFIED, not
   * a pass: `shrk gate` settles its exit on these through the CLI's one guard
   * (`settleVerdict`), so a `warn` that says "not a pass" can never exit 0.
   */
  coverage?: readonly IVerdictCoverage[];
  /** Wall-clock duration of the gate, in ms. */
  durationMs: number;
}

export interface IQualityGateReport {
  schema: typeof QUALITY_GATE_SCHEMA;
  overall: GateStatus;
  startedAt: string;
  totalDurationMs: number;
  /** Counts by status, for fast renderers. */
  counts: Readonly<Record<GateStatus, number>>;
  gates: readonly IGateResult[];
  diagnostics: readonly string[];
}
