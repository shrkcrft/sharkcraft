/**
 * CI integrity report aggregator.
 *
 * Aggregates the JSON reports written by the SharkCraft CI scaffold steps
 * (knowledge-stale.json, template-drift.json, boundaries.json, agent tests,
 * safety audit, product check, release readiness, etc.) into a single
 * "is the PR healthy?" verdict + PR-comment-ready markdown.
 *
 * Schema: sharkcraft.ci-integrity/v1
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export const CI_INTEGRITY_SCHEMA = 'sharkcraft.ci-integrity/v1';

export enum GateStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
  Unknown = 'unknown',
}

export interface ICiGate {
  id: string;
  title: string;
  /** File name (relative) the gate was read from, when applicable. */
  source?: string;
  status: GateStatus;
  errors: number;
  warnings: number;
  /** Short headline. */
  summary: string;
  /** Concrete next command to investigate. */
  nextCommand?: string;
}

export interface ICiIntegrityReport {
  schema: typeof CI_INTEGRITY_SCHEMA;
  generatedAt: string;
  reportsDir: string;
  gates: readonly ICiGate[];
  overall: GateStatus;
  totalErrors: number;
  totalWarnings: number;
  topActionableFailures: readonly string[];
  nextCommands: readonly string[];
}

interface IGateProbe {
  filenameStartsWith: string;
  id: string;
  title: string;
  pickStatus: (raw: unknown) => { status: GateStatus; errors: number; warnings: number; summary: string; nextCommand?: string };
}

function asObj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === 'number' ? v : 0;
}

const PROBES: IGateProbe[] = [
  {
    filenameStartsWith: 'knowledge-stale',
    id: 'knowledge-stale',
    title: 'Knowledge stale-check',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const counts = asObj(o.summary ?? o);
      const stale = num(counts, 'stale');
      const missing = num(counts, 'missing');
      const errors = num(counts, 'requiredStale') + num(counts, 'requiredMissing');
      const warnings = stale + missing - errors;
      const status = errors > 0 ? GateStatus.Fail : warnings > 0 ? GateStatus.Warn : GateStatus.Pass;
      return {
        status,
        errors,
        warnings: warnings < 0 ? 0 : warnings,
        summary: `stale=${stale} missing=${missing}`,
        nextCommand: 'shrk knowledge stale-check --strict',
      };
    },
  },
  {
    filenameStartsWith: 'template-drift',
    id: 'template-drift',
    title: 'Template drift',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const fail = num(o, 'fail');
      const warn = num(o, 'warn');
      const pass = num(o, 'pass');
      const status = fail > 0 ? GateStatus.Fail : warn > 0 ? GateStatus.Warn : GateStatus.Pass;
      return {
        status,
        errors: fail,
        warnings: warn,
        summary: `pass=${pass} warn=${warn} fail=${fail}`,
        nextCommand: 'shrk templates drift --min-severity warning',
      };
    },
  },
  {
    filenameStartsWith: 'boundaries',
    id: 'boundaries',
    title: 'Boundary check',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const violations = Array.isArray(o.violations) ? o.violations.length : num(o, 'violations');
      const status = violations > 0 ? GateStatus.Fail : GateStatus.Pass;
      return {
        status,
        errors: violations,
        warnings: 0,
        summary: `violations=${violations}`,
        nextCommand: 'shrk check boundaries --changed-only',
      };
    },
  },
  {
    filenameStartsWith: 'safety-audit',
    id: 'safety-audit',
    title: 'Safety audit',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const passed = o.passed === true;
      const errors = num(o, 'errors');
      const warnings = num(o, 'warnings');
      const status = !passed || errors > 0 ? GateStatus.Fail : warnings > 0 ? GateStatus.Warn : GateStatus.Pass;
      return {
        status,
        errors,
        warnings,
        summary: passed ? 'safety audit passed' : 'safety audit failed',
        nextCommand: 'shrk safety audit --deep',
      };
    },
  },
  {
    filenameStartsWith: 'agent-tests',
    id: 'agent-tests',
    title: 'Agent contract tests',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const total = Array.isArray(o.results) ? o.results.length : num(o, 'total');
      const passed = num(o, 'passed');
      const failed = num(o, 'failed') || (total - passed);
      const status = failed > 0 ? GateStatus.Fail : GateStatus.Pass;
      return {
        status,
        errors: failed,
        warnings: 0,
        summary: `passed=${passed} failed=${failed} total=${total}`,
        nextCommand: 'shrk test agent',
      };
    },
  },
  {
    filenameStartsWith: 'product',
    id: 'product-check',
    title: 'Product coherence check',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const errors = num(o, 'errors');
      const warnings = num(o, 'warnings');
      const status = errors > 0 ? GateStatus.Fail : warnings > 0 ? GateStatus.Warn : GateStatus.Pass;
      return {
        status,
        errors,
        warnings,
        summary: `errors=${errors} warnings=${warnings}`,
        nextCommand: 'shrk product check',
      };
    },
  },
  {
    filenameStartsWith: 'commands-doctor',
    id: 'commands-doctor',
    title: 'Commands doctor',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const passed = o.passed === true;
      const errors = num(asObj(o.summary), 'errors') || num(o, 'errors');
      const warnings = num(asObj(o.summary), 'warnings') || num(o, 'warnings');
      const status = !passed || errors > 0 ? GateStatus.Fail : warnings > 0 ? GateStatus.Warn : GateStatus.Pass;
      return {
        status,
        errors,
        warnings,
        summary: passed ? 'catalog OK' : 'catalog issues',
        nextCommand: 'shrk commands doctor',
      };
    },
  },
  {
    filenameStartsWith: 'release-readiness',
    id: 'release-readiness',
    title: 'Release readiness',
    pickStatus: (raw) => {
      const o = asObj(raw);
      const passed = o.passed === true || o.ready === true;
      const errors = num(o, 'errors');
      const status = !passed ? GateStatus.Fail : errors > 0 ? GateStatus.Fail : GateStatus.Pass;
      return {
        status,
        errors,
        warnings: 0,
        summary: passed ? 'release ready' : 'release not ready',
        nextCommand: 'shrk release readiness --strict',
      };
    },
  },
];

function loadJson(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface ICiIntegrityOptions {
  reportsDir?: string;
}

export function buildCiIntegrityReport(
  projectRoot: string,
  options: ICiIntegrityOptions = {},
): ICiIntegrityReport {
  const reportsDir = nodePath.isAbsolute(options.reportsDir ?? '.sharkcraft/reports')
    ? (options.reportsDir ?? '.sharkcraft/reports')
    : nodePath.join(projectRoot, options.reportsDir ?? '.sharkcraft/reports');
  const gates: ICiGate[] = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  if (!existsSync(reportsDir)) {
    return {
      schema: CI_INTEGRITY_SCHEMA,
      generatedAt: new Date().toISOString(),
      reportsDir,
      gates: [],
      overall: GateStatus.Unknown,
      totalErrors: 0,
      totalWarnings: 0,
      topActionableFailures: [],
      nextCommands: [`Run \`shrk ci scaffold --with-integrity\` to populate ${reportsDir}`],
    };
  }
  const files = readdirSync(reportsDir).filter((n) => n.endsWith('.json'));
  for (const probe of PROBES) {
    const file = files.find((f) => f.startsWith(probe.filenameStartsWith));
    if (!file) {
      gates.push({
        id: probe.id,
        title: probe.title,
        status: GateStatus.Unknown,
        errors: 0,
        warnings: 0,
        summary: 'no report file present',
      });
      continue;
    }
    const full = nodePath.join(reportsDir, file);
    const raw = loadJson(full);
    const evaluated = probe.pickStatus(raw);
    totalErrors += evaluated.errors;
    totalWarnings += evaluated.warnings;
    gates.push({
      id: probe.id,
      title: probe.title,
      source: nodePath.relative(projectRoot, full),
      status: evaluated.status,
      errors: evaluated.errors,
      warnings: evaluated.warnings,
      summary: evaluated.summary,
      ...(evaluated.nextCommand ? { nextCommand: evaluated.nextCommand } : {}),
    });
  }
  // Overall verdict.
  let overall: GateStatus = GateStatus.Pass;
  let sawFail = false;
  for (const g of gates) {
    if (g.status === GateStatus.Fail) {
      sawFail = true;
      break;
    }
    if (g.status === GateStatus.Warn) overall = GateStatus.Warn;
    if (g.status === GateStatus.Unknown && overall === GateStatus.Pass) overall = GateStatus.Unknown;
  }
  if (sawFail) overall = GateStatus.Fail;
  const failing = gates.filter((g) => g.status === GateStatus.Fail);
  return {
    schema: CI_INTEGRITY_SCHEMA,
    generatedAt: new Date().toISOString(),
    reportsDir,
    gates,
    overall,
    totalErrors,
    totalWarnings,
    topActionableFailures: failing.slice(0, 5).map((g) => `${g.title}: ${g.summary}`),
    nextCommands: failing.slice(0, 5).map((g) => g.nextCommand ?? '').filter(Boolean),
  };
}

function badge(status: GateStatus): string {
  switch (status) {
    case GateStatus.Pass:
      return '✓ pass';
    case GateStatus.Warn:
      return '⚠ warn';
    case GateStatus.Fail:
      return '✗ fail';
    case GateStatus.Unknown:
      return '— unknown';
  }
}

export function renderCiIntegrityMarkdown(report: ICiIntegrityReport): string {
  const lines: string[] = [];
  lines.push('# SharkCraft CI integrity');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Reports dir: \`${report.reportsDir}\``);
  lines.push('');
  lines.push(`Overall: **${badge(report.overall)}**`);
  lines.push(`Totals: errors=${report.totalErrors}, warnings=${report.totalWarnings}`);
  lines.push('');
  lines.push('| Gate | Status | Summary | Next command |');
  lines.push('| --- | --- | --- | --- |');
  for (const g of report.gates) {
    const next = g.nextCommand ? `\`${g.nextCommand}\`` : '—';
    lines.push(`| ${g.title} | ${badge(g.status)} | ${g.summary} | ${next} |`);
  }
  if (report.topActionableFailures.length > 0) {
    lines.push('');
    lines.push('## Top failing gates');
    for (const f of report.topActionableFailures) lines.push(`- ${f}`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('');
    lines.push('## Next commands');
    for (const c of report.nextCommands) lines.push(`- \`${c}\``);
  }
  return lines.join('\n') + '\n';
}

export function renderCiIntegrityHtml(report: ICiIntegrityReport): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = report.gates
    .map((g) => `<tr><td>${esc(g.title)}</td><td>${badge(g.status)}</td><td>${esc(g.summary)}</td><td>${g.nextCommand ? `<code>${esc(g.nextCommand)}</code>` : ''}</td></tr>`)
    .join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>SharkCraft — CI integrity</title>',
    '<style>body{font:14px/1.5 -apple-system,sans-serif;max-width:960px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:6px 10px}th{background:#f6f8fa}</style>',
    '</head><body>',
    `<h1>SharkCraft CI integrity</h1>`,
    `<p>Overall: <strong>${badge(report.overall)}</strong></p>`,
    `<table><thead><tr><th>Gate</th><th>Status</th><th>Summary</th><th>Next</th></tr></thead><tbody>${rows}</tbody></table>`,
    '</body></html>',
  ].join('\n');
}
