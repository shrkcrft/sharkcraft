/**
 * CI predict / would-fail.
 *
 * Deterministic local prediction of likely CI gate outcomes based on the
 * latest JSON reports under `.sharkcraft/reports/` (the same files the CI
 * scaffold writes). Read-only — does not run any commands; just inspects
 * cached state.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';

export const CI_PREDICT_SCHEMA = 'sharkcraft.ci-predict/v1';

export enum CiPredictProfileId {
  GithubPr = 'github-pr',
  Release = 'release',
  Pack = 'pack',
  Self = 'self',
}

export enum CiPredictVerdict {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  Unknown = 'unknown',
}

export interface ICiPredictGate {
  readonly id: string;
  readonly title: string;
  readonly verdict: CiPredictVerdict;
  readonly summary: string;
  readonly report?: string;
  readonly nextCommand?: string;
}

export interface ICiPredictReport {
  readonly schema: typeof CI_PREDICT_SCHEMA;
  readonly profileId: CiPredictProfileId;
  readonly generatedAt: string;
  readonly verdict: CiPredictVerdict;
  readonly gates: readonly ICiPredictGate[];
  readonly missingReports: readonly string[];
  readonly nextCommands: readonly string[];
  /** Uncertainty report (confidence + signals + safe fallback). */
  readonly uncertainty?: IUncertaintyReport;
}

interface IGateProbe {
  id: string;
  title: string;
  reportFile: string;
  reader: (json: Record<string, unknown>) => { verdict: CiPredictVerdict; summary: string };
  nextCommand: string;
}

const PROBES: Record<CiPredictProfileId, IGateProbe[]> = {
  [CiPredictProfileId.Self]: [
    {
      id: 'doctor',
      title: 'Workspace doctor',
      reportFile: 'doctor.json',
      reader: (j) => {
        const errors = Number(((j['summary'] as Record<string, unknown> | undefined)?.['errors']) ?? 0);
        return {
          verdict: errors > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: errors > 0 ? `${errors} doctor errors` : 'doctor clean',
        };
      },
      nextCommand: 'shrk doctor',
    },
    {
      id: 'self-config',
      title: 'Self-config doctor',
      reportFile: 'self-config-doctor.json',
      reader: (j) => {
        const v = j['verdict'] as string | undefined;
        return {
          verdict: v === 'errors' ? CiPredictVerdict.Fail : v === 'warnings' ? CiPredictVerdict.Warn : CiPredictVerdict.Pass,
          summary: `verdict=${v ?? 'unknown'}`,
        };
      },
      nextCommand: 'shrk self-config doctor',
    },
    {
      id: 'knowledge-stale',
      title: 'Knowledge stale-check',
      reportFile: 'knowledge-stale.json',
      reader: (j) => {
        const required = Number(((j['totals'] as Record<string, unknown> | undefined)?.['requiredStale']) ?? 0);
        return {
          verdict: required > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `requiredStale=${required}`,
        };
      },
      nextCommand: 'shrk knowledge stale-check --ci',
    },
    {
      id: 'template-drift',
      title: 'Templates drift',
      reportFile: 'template-drift.json',
      reader: (j) => {
        const fail = Number(((j['totals'] as Record<string, unknown> | undefined)?.['fail']) ?? 0);
        return {
          verdict: fail > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `fail=${fail}`,
        };
      },
      nextCommand: 'shrk templates drift --min-severity warning',
    },
    {
      id: 'agent-tests',
      title: 'Agent contract tests',
      reportFile: 'agent-tests.json',
      reader: (j) => {
        const failed = Number(((j['summary'] as Record<string, unknown> | undefined)?.['failed']) ?? 0);
        return {
          verdict: failed > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `failed=${failed}`,
        };
      },
      nextCommand: 'shrk test agent',
    },
  ],
  [CiPredictProfileId.GithubPr]: [
    {
      id: 'boundaries-changed-only',
      title: 'Boundaries (changed-only)',
      reportFile: 'boundaries.json',
      reader: (j) => {
        const v = Number(((j['summary'] as Record<string, unknown> | undefined)?.['violations']) ?? 0);
        return {
          verdict: v > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `violations=${v}`,
        };
      },
      nextCommand: 'shrk check boundaries --changed-only',
    },
    {
      id: 'commands-doctor',
      title: 'Commands doctor',
      reportFile: 'commands-doctor.json',
      reader: (j) => {
        const e = Number(((j['summary'] as Record<string, unknown> | undefined)?.['errors']) ?? 0);
        return {
          verdict: e > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `errors=${e}`,
        };
      },
      nextCommand: 'shrk commands doctor',
    },
  ],
  [CiPredictProfileId.Release]: [
    {
      id: 'release-readiness',
      title: 'Release readiness',
      reportFile: 'release-readiness.json',
      reader: (j) => {
        const ready = Boolean(j['ready']);
        return {
          verdict: ready ? CiPredictVerdict.Pass : CiPredictVerdict.Fail,
          summary: `ready=${ready}`,
        };
      },
      nextCommand: 'shrk release readiness --strict',
    },
  ],
  [CiPredictProfileId.Pack]: [
    {
      id: 'pack-doctor',
      title: 'Pack doctor',
      reportFile: 'pack-doctor.json',
      reader: (j) => {
        const errors = Number(((j['summary'] as Record<string, unknown> | undefined)?.['errors']) ?? 0);
        return {
          verdict: errors > 0 ? CiPredictVerdict.Fail : CiPredictVerdict.Pass,
          summary: `errors=${errors}`,
        };
      },
      nextCommand: 'shrk packs doctor',
    },
  ],
};

export interface ICiPredictOptions {
  readonly projectRoot: string;
  readonly profileId: CiPredictProfileId;
  readonly reportsDir?: string;
}

export function buildCiPredictReport(options: ICiPredictOptions): ICiPredictReport {
  const reportsDir = options.reportsDir
    ? (nodePath.isAbsolute(options.reportsDir) ? options.reportsDir : nodePath.resolve(options.projectRoot, options.reportsDir))
    : nodePath.join(options.projectRoot, '.sharkcraft', 'reports');

  const probes = PROBES[options.profileId] ?? [];
  const gates: ICiPredictGate[] = [];
  const missingReports: string[] = [];

  for (const p of probes) {
    const file = nodePath.join(reportsDir, p.reportFile);
    if (!existsSync(file)) {
      missingReports.push(p.reportFile);
      gates.push({
        id: p.id,
        title: p.title,
        verdict: CiPredictVerdict.Unknown,
        summary: 'report missing — run the command first',
        nextCommand: p.nextCommand,
      });
      continue;
    }
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const r = p.reader(json);
      gates.push({
        id: p.id,
        title: p.title,
        verdict: r.verdict,
        summary: r.summary,
        report: p.reportFile,
        nextCommand: p.nextCommand,
      });
    } catch (e) {
      gates.push({
        id: p.id,
        title: p.title,
        verdict: CiPredictVerdict.Unknown,
        summary: `unable to parse: ${(e as Error).message}`,
        nextCommand: p.nextCommand,
      });
    }
  }

  const verdict: CiPredictVerdict = gates.some((g) => g.verdict === CiPredictVerdict.Fail)
    ? CiPredictVerdict.Fail
    : gates.some((g) => g.verdict === CiPredictVerdict.Warn)
      ? CiPredictVerdict.Warn
      : gates.every((g) => g.verdict === CiPredictVerdict.Pass)
        ? CiPredictVerdict.Pass
        : CiPredictVerdict.Unknown;

  const nextCommands: string[] = [];
  for (const g of gates) {
    if ((g.verdict === CiPredictVerdict.Fail || g.verdict === CiPredictVerdict.Unknown) && g.nextCommand) {
      nextCommands.push(g.nextCommand);
    }
  }

  // Uncertainty model.
  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'high';
  const reasons: string[] = [];
  const missing: { id: string; message: string }[] = [];
  const conflicting: { id: string; message: string }[] = [];
  if (missingReports.length > 0) {
    confidence = 'low';
    reasons.push(`${missingReports.length} cached report(s) missing — verdict for those gates is unknown.`);
    for (const r of missingReports) missing.push({ id: 'missing-report', message: `${r} not cached.` });
  } else if (gates.some((g) => g.verdict === CiPredictVerdict.Unknown)) {
    confidence = 'medium';
    reasons.push('At least one gate could not be evaluated.');
    for (const g of gates) {
      if (g.verdict === CiPredictVerdict.Unknown) {
        conflicting.push({ id: g.id, message: g.summary });
      }
    }
  } else if (gates.some((g) => g.verdict === CiPredictVerdict.Warn)) {
    confidence = 'medium';
    reasons.push('At least one gate is in warn state.');
  } else if (gates.length === 0) {
    confidence = 'unknown';
    reasons.push('No probes defined for this profile.');
  }
  // Build uncertainty.
  const uncertainty = buildUncertaintyReport({
    confidence,
    reasons,
    missingSignals: missing,
    conflictingSignals: conflicting,
    suggestedCommands: nextCommands.slice(0, 5),
    safeFallbackCommand:
      missingReports.length > 0
        ? `# Run the cached commands first: ${missingReports.join(', ')}`
        : 'shrk doctor',
    whatWouldIncreaseConfidence:
      missingReports.length > 0
        ? ['Run the gate commands to populate cached reports.']
        : [],
  });

  return {
    schema: CI_PREDICT_SCHEMA,
    profileId: options.profileId,
    generatedAt: new Date().toISOString(),
    verdict,
    gates,
    missingReports,
    nextCommands,
    uncertainty,
  };
}

export function renderCiPredictText(report: ICiPredictReport): string {
  const lines: string[] = [];
  lines.push(`=== CI predict (${report.profileId}) ===`);
  lines.push(`  generatedAt   ${report.generatedAt}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push(`  gates         ${report.gates.length}`);
  lines.push(`  missing       ${report.missingReports.length}`);
  lines.push('');
  for (const g of report.gates) {
    lines.push(`  ${g.verdict.padEnd(7)} ${g.id.padEnd(28)} ${g.title}  (${g.summary})`);
    if (g.nextCommand && (g.verdict === 'fail' || g.verdict === 'unknown')) {
      lines.push(`           next: ${g.nextCommand}`);
    }
  }
  if (report.nextCommands.length > 0) {
    lines.push('\nNext commands:');
    for (const c of report.nextCommands) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function renderCiPredictMarkdown(report: ICiPredictReport): string {
  const lines: string[] = ['# CI predict', ''];
  lines.push(`- profile: \`${report.profileId}\``);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push('');
  lines.push('| Verdict | Gate | Summary | Next |');
  lines.push('| --- | --- | --- | --- |');
  for (const g of report.gates) {
    lines.push(`| ${g.verdict} | \`${g.id}\` | ${g.summary} | ${g.nextCommand ?? ''} |`);
  }
  if (report.missingReports.length > 0) {
    lines.push('');
    lines.push(`## Missing reports`);
    for (const r of report.missingReports) lines.push(`- \`${r}\``);
  }
  return lines.join('\n') + '\n';
}
