import type { IGateResult, IQualityGateReport } from '../schema/quality-gate.ts';

/**
 * PR-comment-ready markdown rendering of a quality-gate report.
 *
 * Sections (top-down):
 *   1. Header with overall status badge.
 *   2. Counts table (pass / warn / fail / skipped).
 *   3. Per-gate detail rows with status icon, label, message, and
 *      a fenced code block of next commands when present.
 *
 * Stable structure so downstream GitHub bots can diff it across runs
 * without parsing JSON. Pure function — no I/O.
 */
export function renderGateReportMarkdown(report: IQualityGateReport): string {
  const lines: string[] = [];
  lines.push(`# SharkCraft quality gates: ${statusBadge(report.overall)}`);
  lines.push('');
  lines.push(`Total duration: \`${report.totalDurationMs}ms\`.`);
  lines.push('');
  lines.push('| pass | warn | fail | skipped |');
  lines.push('|---|---|---|---|');
  lines.push(
    `| ${report.counts.pass} | ${report.counts.warn} | ${report.counts.fail} | ${report.counts.skipped} |`,
  );
  lines.push('');
  if (report.gates.length === 0) {
    lines.push('_(no gates ran)_');
    return lines.join('\n') + '\n';
  }
  lines.push('## Gates');
  lines.push('');
  for (const gate of report.gates) {
    lines.push(renderGate(gate));
    lines.push('');
  }
  if (report.diagnostics.length > 0) {
    lines.push('## Diagnostics');
    for (const d of report.diagnostics.slice(0, 20)) {
      lines.push(`- ${d}`);
    }
  }
  return lines.join('\n') + '\n';
}

function statusBadge(status: IQualityGateReport['overall']): string {
  switch (status) {
    case 'pass':
      return '✅ PASS';
    case 'warn':
      return '⚠️ WARN';
    case 'fail':
      return '❌ FAIL';
    case 'skipped':
      return '⏭️ SKIPPED';
  }
}

function gateIcon(status: IGateResult['status']): string {
  switch (status) {
    case 'pass':
      return '✅';
    case 'warn':
      return '⚠️';
    case 'fail':
      return '❌';
    case 'skipped':
      return '⏭️';
  }
}

function renderGate(gate: IGateResult): string {
  const parts: string[] = [];
  parts.push(`### ${gateIcon(gate.status)} \`${gate.id}\` — ${gate.label}`);
  parts.push('');
  parts.push(`**Status:** \`${gate.status}\` · **Duration:** \`${gate.durationMs}ms\``);
  parts.push('');
  parts.push(gate.message);
  if (gate.nextCommands && gate.nextCommands.length > 0) {
    parts.push('');
    parts.push('Next steps:');
    parts.push('');
    parts.push('```bash');
    for (const c of gate.nextCommands) parts.push(c);
    parts.push('```');
  }
  return parts.join('\n');
}
