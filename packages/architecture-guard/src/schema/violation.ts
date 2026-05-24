export const ARCH_REPORT_SCHEMA = 'sharkcraft.architecture-report/v1' as const;

export type ArchViolationSeverity = 'error' | 'warning' | 'info';

export type ArchViolationKind =
  | 'public-api-misuse'
  | 'barrel-cycle'
  | 'barrel-fat'
  | 'cycle'
  | 'contract-import'
  | 'contract-layer-skip';

export interface IArchViolation {
  kind: ArchViolationKind;
  severity: ArchViolationSeverity;
  /** Short headline. */
  message: string;
  /** Project-relative file path the violation originates from. */
  file: string;
  /** Optional line number. */
  line?: number;
  /** Optional file the violation targets (e.g. illegal import target). */
  targetFile?: string;
  /** Optional fix hint shown to the agent / human. */
  suggestedFix?: string;
  /** Graph node ids involved (for renderers). */
  refs?: readonly string[];
}

export interface IArchReport {
  schema: typeof ARCH_REPORT_SCHEMA;
  /** Number of files considered by the report. */
  filesAnalyzed: number;
  violations: readonly IArchViolation[];
  countsBySeverity: Readonly<Record<ArchViolationSeverity, number>>;
  countsByKind: Readonly<Record<ArchViolationKind, number>>;
  diagnostics: readonly string[];
}
