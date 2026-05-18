/**
 * Shared uncertainty report shape.
 *
 * Extends `IUncertaintySummary` with a richer surface: reasons /
 * missingSignals / conflictingSignals / suggestedCommands /
 * safeFallbackCommand / whatWouldIncreaseConfidence.
 *
 * Pure, deterministic; can be derived from `IUncertaintySummary` or a
 * fresh task packet.
 */
import {
  buildUncertaintySummary,
  UncertaintyLevel,
  type IUncertaintySummary,
} from './uncertainty.ts';
import type { ITaskPacket } from './task-packet.ts';

export const UNCERTAINTY_REPORT_SCHEMA = 'sharkcraft.uncertainty-report/v1';

export interface IUncertaintySignalDetail {
  readonly id: string;
  readonly message: string;
}

export interface IUncertaintyReport {
  readonly schema: typeof UNCERTAINTY_REPORT_SCHEMA;
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown';
  readonly reasons: readonly string[];
  readonly missingSignals: readonly IUncertaintySignalDetail[];
  readonly conflictingSignals: readonly IUncertaintySignalDetail[];
  readonly suggestedCommands: readonly string[];
  readonly safeFallbackCommand: string;
  readonly whatWouldIncreaseConfidence: readonly string[];
}

function levelToString(level: UncertaintyLevel): 'high' | 'medium' | 'low' {
  if (level === UncertaintyLevel.High) return 'high';
  if (level === UncertaintyLevel.Medium) return 'medium';
  return 'low';
}

export function uncertaintyReportFromSummary(
  summary: IUncertaintySummary,
  fallback = 'shrk task "<task>" --commands-first',
): IUncertaintyReport {
  const missing: IUncertaintySignalDetail[] = [];
  const conflicting: IUncertaintySignalDetail[] = [];
  const reasons: string[] = [];
  for (const s of summary.uncertainty) {
    if (s.code.startsWith('conflict-')) {
      conflicting.push({ id: s.code, message: s.message });
    } else {
      missing.push({ id: s.code, message: s.message });
    }
    reasons.push(s.message);
  }
  const increaseConfidence = missing.map((m) => {
    if (m.id.startsWith('no-template')) return 'Add a matching template (shrk templates list).';
    if (m.id.startsWith('no-pipeline')) return 'Add a pipeline (sharkcraft/pipelines.ts).';
    if (m.id.startsWith('no-path-convention')) return 'Add a path convention (shrk paths list).';
    if (m.id.startsWith('no-validation-command')) return 'Declare verificationCommands on the matched rule.';
    if (m.id.startsWith('weak-knowledge')) return 'Add knowledge with broader appliesWhen tokens.';
    if (m.id.startsWith('low-ranker-confidence')) return 'Add search-tuning bias for the task tokens.';
    return `Resolve "${m.id}".`;
  });
  return {
    schema: UNCERTAINTY_REPORT_SCHEMA,
    confidence: levelToString(summary.confidence),
    reasons,
    missingSignals: missing,
    conflictingSignals: conflicting,
    suggestedCommands: summary.suggestedCommands,
    safeFallbackCommand: fallback,
    whatWouldIncreaseConfidence: Array.from(new Set(increaseConfidence)),
  };
}

export function buildUncertaintyReportFromPacket(packet: ITaskPacket): IUncertaintyReport {
  const summary = buildUncertaintySummary(packet);
  return uncertaintyReportFromSummary(summary);
}

/**
 * Generic builder. Surfaces that don't have a task packet (PR summary,
 * CI predict, handoff, contract) construct their own `IUncertaintyReport`
 * by listing concrete signals.
 */
export interface IBuildUncertaintyReportInput {
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown';
  readonly reasons?: readonly string[];
  readonly missingSignals?: readonly IUncertaintySignalDetail[];
  readonly conflictingSignals?: readonly IUncertaintySignalDetail[];
  readonly suggestedCommands?: readonly string[];
  readonly safeFallbackCommand: string;
  readonly whatWouldIncreaseConfidence?: readonly string[];
}

export function buildUncertaintyReport(input: IBuildUncertaintyReportInput): IUncertaintyReport {
  return {
    schema: UNCERTAINTY_REPORT_SCHEMA,
    confidence: input.confidence,
    reasons: input.reasons ?? [],
    missingSignals: input.missingSignals ?? [],
    conflictingSignals: input.conflictingSignals ?? [],
    suggestedCommands: input.suggestedCommands ?? [],
    safeFallbackCommand: input.safeFallbackCommand,
    whatWouldIncreaseConfidence: input.whatWouldIncreaseConfidence ?? [],
  };
}

export function renderUncertaintyReportText(report: IUncertaintyReport): string {
  const lines: string[] = [];
  lines.push(`Confidence: ${report.confidence.toUpperCase()}`);
  if (report.confidence === 'low' || report.confidence === 'unknown') {
    lines.push('⚠  Low confidence — review carefully before acting on these recommendations.');
  }
  if (report.reasons.length > 0) {
    lines.push('Reasons:');
    for (const r of report.reasons.slice(0, 6)) lines.push(`  • ${r}`);
  }
  if (report.missingSignals.length > 0) {
    lines.push('Missing signals:');
    for (const m of report.missingSignals.slice(0, 6)) lines.push(`  • ${m.id} — ${m.message}`);
  }
  if (report.conflictingSignals.length > 0) {
    lines.push('Conflicting signals:');
    for (const c of report.conflictingSignals.slice(0, 6)) lines.push(`  • ${c.id} — ${c.message}`);
  }
  if (report.whatWouldIncreaseConfidence.length > 0) {
    lines.push('What would increase confidence:');
    for (const w of report.whatWouldIncreaseConfidence.slice(0, 6)) lines.push(`  • ${w}`);
  }
  if (report.suggestedCommands.length > 0) {
    lines.push('Suggested commands:');
    for (const c of report.suggestedCommands.slice(0, 6)) lines.push(`  • ${c}`);
  }
  lines.push(`Safe fallback: ${report.safeFallbackCommand}`);
  return lines.join('\n');
}
