import {
  buildCodeIntelligenceChecks,
  DoctorSeverity,
  type IDoctorCheck,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk code-intel` — one-shot view of the 14 code-intelligence
 * doctor checks. Independent of `shrk doctor` so callers (agents,
 * inner-loop scripts, the dashboard) can pull just this section
 * without parsing through unrelated config / knowledge findings.
 *
 * Output modes:
 *   - text (default): grouped by severity, one line per finding.
 *   - --json: machine-readable, including the full check list.
 *   - --markdown: PR-comment-ready rendering.
 *
 * Filters:
 *   - --only ok,warning,error,info — restrict severities.
 *   - --check <id>                 — show only one check id.
 */
export const codeIntelCommand: ICommandHandler = {
  name: 'code-intel',
  description:
    'One-shot view of code-intelligence doctor checks (graph, rule-graph, api-surface, quality-gate, migrations, architecture, impact, framework, structural-search, context-planner). Read-only.',
  usage:
    'shrk [--cwd <dir>] code-intel [--json] [--markdown] [--only ok,warning,error,info] [--check <id>] [--stale-days N]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const wantMarkdown = flagBool(args, 'markdown');
    const onlyRaw = flagString(args, 'only');
    const checkId = flagString(args, 'check');
    const staleDaysRaw = flagString(args, 'stale-days');
    const staleDays = staleDaysRaw ? Number.parseInt(staleDaysRaw, 10) : undefined;
    const options: { staleThresholdDays?: number } = {};
    if (typeof staleDays === 'number' && Number.isFinite(staleDays) && staleDays > 0) {
      options.staleThresholdDays = staleDays;
    }
    let checks = buildCodeIntelligenceChecks(cwd, options);
    if (checkId) {
      checks = checks.filter((c) => c.id === checkId);
    }
    if (onlyRaw) {
      const allowed = new Set(
        onlyRaw
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0),
      );
      checks = checks.filter((c) => allowed.has(severityKey(c.severity)));
    }
    const summary = summarize(checks);
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.code-intelligence-state/v1',
          totalChecks: checks.length,
          summary,
          checks,
        }) + '\n',
      );
      return exitCode(summary);
    }
    if (wantMarkdown) {
      process.stdout.write(renderMarkdown(checks, summary));
      return exitCode(summary);
    }
    process.stdout.write(header('Code-intelligence state'));
    process.stdout.write(
      kv(
        'summary',
        `ok=${summary.ok} info=${summary.info} warnings=${summary.warnings} errors=${summary.errors}`,
      ) + '\n',
    );
    if (checks.length === 0) {
      process.stdout.write('\nNo code-intelligence state on disk yet — opt in by running `shrk graph index`.\n');
      return 0;
    }
    process.stdout.write('\n');
    for (const c of checks) {
      const icon = severityIcon(c.severity);
      const advisory = c.advisory ? ' (advisory)' : '';
      process.stdout.write(`${icon} ${c.id}${advisory}\n`);
      process.stdout.write(`   ${c.title}\n`);
      process.stdout.write(`   ${c.message}\n`);
      if (c.fix) process.stdout.write(`   → ${c.fix}\n`);
      if (c.whyThisMatters) process.stdout.write(`   why: ${c.whyThisMatters}\n`);
      process.stdout.write('\n');
    }
    return exitCode(summary);
  },
};

function severityKey(severity: DoctorSeverity): string {
  return severity;
}

function severityIcon(severity: DoctorSeverity): string {
  switch (severity) {
    case DoctorSeverity.Ok:
      return '✓';
    case DoctorSeverity.Info:
      return 'ℹ';
    case DoctorSeverity.Warning:
      return '⚠';
    case DoctorSeverity.Error:
      return '✗';
  }
}

interface ISummary {
  ok: number;
  info: number;
  warnings: number;
  errors: number;
}

function summarize(checks: readonly IDoctorCheck[]): ISummary {
  const s: ISummary = { ok: 0, info: 0, warnings: 0, errors: 0 };
  for (const c of checks) {
    if (c.severity === DoctorSeverity.Ok) s.ok += 1;
    else if (c.severity === DoctorSeverity.Info) s.info += 1;
    else if (c.severity === DoctorSeverity.Warning) s.warnings += 1;
    else if (c.severity === DoctorSeverity.Error) s.errors += 1;
  }
  return s;
}

function exitCode(summary: ISummary): number {
  // Exit 1 if any non-advisory warning or error remains. Advisory
  // warnings are reported but never fail the command — they're hints,
  // not blockers (same contract as `shrk doctor`).
  return summary.errors > 0 ? 1 : 0;
}

function renderMarkdown(
  checks: readonly IDoctorCheck[],
  summary: ISummary,
): string {
  const lines: string[] = [];
  lines.push('# SharkCraft code-intelligence state');
  lines.push('');
  lines.push('| ok | info | warnings | errors |');
  lines.push('|---|---|---|---|');
  lines.push(`| ${summary.ok} | ${summary.info} | ${summary.warnings} | ${summary.errors} |`);
  lines.push('');
  if (checks.length === 0) {
    lines.push('_(no code-intelligence state on disk yet)_');
    return lines.join('\n') + '\n';
  }
  for (const c of checks) {
    const icon = severityIcon(c.severity);
    const advisory = c.advisory ? ' _(advisory)_' : '';
    lines.push(`### ${icon} \`${c.id}\` — ${c.title}${advisory}`);
    lines.push('');
    lines.push(c.message);
    if (c.fix) {
      lines.push('');
      lines.push(`**Fix:** ${c.fix}`);
    }
    if (c.whyThisMatters) {
      lines.push('');
      lines.push(`**Why:** ${c.whyThisMatters}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
