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
