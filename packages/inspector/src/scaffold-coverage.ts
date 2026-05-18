/**
 * Scaffold / template / playbook coverage gaps.
 *
 * For a task or domain, surface what the engine already has wired up and
 * what is missing — knowledge, rules, path conventions, templates, scaffold
 * patterns, playbooks, helpers, validation commands, contract templates —
 * with a coverage grade and concrete additions to consider.
 *
 * Pure, deterministic, read-only. Schema: sharkcraft.scaffold-coverage/v1.
 */
import { listAllContractTemplates } from './contract-template-registry.ts';
import { listConstructs } from './construct-registry.ts';
import { HELPERS, type IHelperDefinition } from './helper-registry.ts';
import { listPlaybooks } from './playbook-registry.ts';
import {
  loadScaffoldPatternsFromInspection,
  type IScaffoldPatternWithSource,
} from './scaffold-patterns.ts';
import { rankAll, type IRankAllResult } from './task-ranker.ts';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const SCAFFOLD_COVERAGE_SCHEMA = 'sharkcraft.scaffold-coverage/v1';

export enum CoverageGrade {
  Full = 'full',
  Partial = 'partial',
  Weak = 'weak',
  Missing = 'missing',
}

export interface IAxisMatch {
  axis: string;
  matched: boolean;
  matchCount: number;
  topIds: readonly string[];
  /** Optional per-axis notes (warnings or hints). */
  notes?: readonly string[];
}

export interface IScaffoldCoverageReport {
  schema: typeof SCAFFOLD_COVERAGE_SCHEMA;
  generatedAt: string;
  task?: string;
  domain?: string;
  /** Per-axis matches. */
  axes: readonly IAxisMatch[];
  /** Overall confidence 0–1. */
  confidence: number;
  /** Grade derived from axis matches. */
  grade: CoverageGrade;
  /** Missing axes that have the largest impact. */
  missing: readonly string[];
  /** Suggested additions — concrete pack/local entries the author could add. */
  suggestedAdditions: readonly string[];
  /** Concrete next commands. */
  nextCommands: readonly string[];
  /** Uncertainty report (confidence + signals + safe fallback). */
  uncertainty?: IUncertaintyReport;
}

export interface IScaffoldCoverageOptions {
  task?: string;
  domain?: string;
  /** Top-N ranked items to consider per axis. Default 8. */
  topN?: number;
}

function lower(s: string | undefined): string {
  return (s ?? '').toLowerCase();
}

function makeAxis(
  axis: string,
  ranked: readonly { id: string; score: number }[],
  threshold = 1,
): IAxisMatch {
  const filtered = ranked.filter((r) => r.score >= threshold);
  return {
    axis,
    matched: filtered.length > 0,
    matchCount: filtered.length,
    topIds: filtered.slice(0, 5).map((r) => r.id),
  };
}

function scoreAxis<T extends { id: string; tags?: readonly string[] }>(
  items: readonly T[],
  taskLower: string,
  domain: string | undefined,
): { id: string; score: number }[] {
  const tokens = taskLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const out: { id: string; score: number }[] = [];
  for (const item of items) {
    let score = 0;
    const idLower = item.id.toLowerCase();
    for (const t of tokens) if (idLower.includes(t)) score += 2;
    if (domain && idLower.includes(domain.toLowerCase())) score += 3;
    if (item.tags) {
      for (const tag of item.tags) {
        if (tokens.includes(tag.toLowerCase())) score += 2;
        if (domain && tag.toLowerCase() === domain.toLowerCase()) score += 3;
      }
    }
    if (score > 0) out.push({ id: item.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function gradeFromCounts(matchedCount: number, totalAxes: number): CoverageGrade {
  const ratio = totalAxes === 0 ? 0 : matchedCount / totalAxes;
  if (ratio >= 0.85) return CoverageGrade.Full;
  if (ratio >= 0.55) return CoverageGrade.Partial;
  if (ratio >= 0.25) return CoverageGrade.Weak;
  return CoverageGrade.Missing;
}

function suggestAdditions(missing: readonly string[], taskOrDomain: string): string[] {
  const out: string[] = [];
  const tokens = taskOrDomain.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hint = tokens.slice(0, 3).join('-') || 'this-task';
  for (const axis of missing) {
    switch (axis) {
      case 'templates':
        out.push(`Add a template (e.g. \`<scope>.${hint}\`) under sharkcraft/ or the relevant pack.`);
        break;
      case 'scaffold-patterns':
        out.push(`Add a scaffold pattern matching the relevant paths for \`${hint}\`.`);
        break;
      case 'playbooks':
        out.push(`Add a playbook documenting the canonical sequence for \`${hint}\`.`);
        break;
      case 'helpers':
        out.push(`Add a helper plan generator if this task involves repeatable plan-only steps.`);
        break;
      case 'path-conventions':
        out.push(`Add a path convention for \`${hint}\` so templates can target a canonical path.`);
        break;
      case 'knowledge':
        out.push(`Add a knowledge entry explaining \`${hint}\` (verifiable references).`);
        break;
      case 'rules':
        out.push(`Add a rule with actionHints and verificationCommands for \`${hint}\`.`);
        break;
      case 'validation-commands':
        out.push(`Declare verificationCommands on the related rules / templates / playbooks.`);
        break;
      case 'contract-templates':
        out.push(`Add an agent-contract template for the \`${hint}\` workflow.`);
        break;
    }
  }
  return out;
}

function buildNextCommands(taskOrDomain: string): string[] {
  return [
    `shrk why-not <id> --for-task "${taskOrDomain}"`,
    `shrk search "${taskOrDomain}" --explain`,
    `shrk task "${taskOrDomain}" --show-coverage-gaps`,
    `shrk fix preview --template-drift`,
  ];
}

export async function buildScaffoldCoverageReport(
  inspection: ISharkcraftInspection,
  options: IScaffoldCoverageOptions = {},
): Promise<IScaffoldCoverageReport> {
  const task = options.task ?? '';
  const domain = options.domain;
  const taskOrDomain = task || domain || '';
  if (!taskOrDomain) {
    return emptyReport();
  }
  const taskLower = taskOrDomain.toLowerCase();

  // Ranker output (rules / paths / templates / pipelines).
  const ranking: IRankAllResult = rankAll(inspection, taskOrDomain, options.topN ?? 8);

  const constructs = listConstructs(inspection);
  const playbooks = listPlaybooks(inspection);
  const helpers: readonly IHelperDefinition[] = HELPERS;
  const contractTemplates = await listAllContractTemplates(inspection);
  const scaffoldsLoad = await loadScaffoldPatternsFromInspection(inspection);
  const scaffolds: IScaffoldPatternWithSource[] = scaffoldsLoad.patterns;

  const knowledgeMatches = scoreAxis(
    inspection.knowledgeEntries.map((k) => ({
      id: k.id,
      ...(k.tags ? { tags: k.tags } : {}),
    })),
    taskLower,
    domain,
  );

  const helperMatches = scoreAxis(
    helpers.map((h) => ({ id: h.id, tags: [h.description] })),
    taskLower,
    domain,
  );

  const playbookMatches = scoreAxis(
    playbooks.map((p) => ({ id: p.id, tags: p.tags ?? [] })),
    taskLower,
    domain,
  );

  const scaffoldMatches = scoreAxis(
    scaffolds.map((s) => ({ id: s.pattern.id })),
    taskLower,
    domain,
  );

  const contractMatches = scoreAxis(
    contractTemplates.map((c: { id: string; tags?: readonly string[] }) => ({
      id: c.id,
      tags: c.tags ?? [],
    })),
    taskLower,
    domain,
  );

  const validationCmds = collectVerificationCommands(inspection);

  const axes: IAxisMatch[] = [
    makeAxis('knowledge', knowledgeMatches),
    makeAxis('rules', ranking.rules.map((r) => ({ id: r.item.id, score: r.score }))),
    makeAxis('path-conventions', ranking.paths.map((r) => ({ id: r.item.id, score: r.score }))),
    makeAxis('templates', ranking.templates.map((r) => ({ id: r.item.id, score: r.score }))),
    makeAxis('scaffold-patterns', scaffoldMatches),
    makeAxis('playbooks', playbookMatches),
    makeAxis('helpers', helperMatches),
    makeAxis('validation-commands', validationCmds.map((v, i) => ({ id: `verification[${i}]:${v}`, score: tokenScore(v, taskLower) })).filter((x) => x.score > 0)),
    makeAxis('contract-templates', contractMatches),
  ];

  // Also report which constructs match.
  if (constructs.length > 0) {
    const constructMatches = scoreAxis(
      constructs.map((c) => ({ id: c.id, tags: c.tags ?? [] })),
      taskLower,
      domain,
    );
    axes.push(makeAxis('constructs', constructMatches));
  }

  const matchedAxes = axes.filter((a) => a.matched).length;
  const grade = gradeFromCounts(matchedAxes, axes.length);
  const missing = axes.filter((a) => !a.matched).map((a) => a.axis);
  const confidence = Math.min(1, Math.max(0, matchedAxes / axes.length));

  let coverageConfidence: 'high' | 'medium' | 'low' | 'unknown' = 'high';
  if (confidence < 0.5) coverageConfidence = 'low';
  else if (confidence < 0.8) coverageConfidence = 'medium';
  const reasons: string[] = [];
  const missingSignals: { id: string; message: string }[] = [];
  for (const m of missing) {
    missingSignals.push({ id: `axis-missing-${m}`, message: `Axis "${m}" has no matching scaffold entry.` });
  }
  if (missing.length > 0) {
    reasons.push(`${missing.length} of ${axes.length} coverage axis/axes are missing.`);
  }
  const uncertainty = buildUncertaintyReport({
    confidence: coverageConfidence,
    reasons,
    missingSignals,
    suggestedCommands: buildNextCommands(taskOrDomain),
    safeFallbackCommand: 'shrk feedback actions',
    whatWouldIncreaseConfidence: suggestAdditions(missing, taskOrDomain),
  });

  return {
    schema: SCAFFOLD_COVERAGE_SCHEMA,
    generatedAt: new Date().toISOString(),
    ...(task ? { task } : {}),
    ...(domain ? { domain } : {}),
    axes,
    confidence,
    grade,
    missing,
    suggestedAdditions: suggestAdditions(missing, taskOrDomain),
    nextCommands: buildNextCommands(taskOrDomain),
    uncertainty,
  };
}

function tokenScore(text: string, taskLower: string): number {
  const t = text.toLowerCase();
  const tokens = taskLower.split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
  let score = 0;
  for (const tk of tokens) if (t.includes(tk)) score += 1;
  return score;
}

function collectVerificationCommands(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  for (const r of inspection.knowledgeEntries) {
    const ah = r.actionHints;
    if (!ah) continue;
    const list = (ah.verificationCommands ?? []) as readonly (string | { command: string })[];
    for (const v of list) {
      out.push(typeof v === 'string' ? v : v.command);
    }
  }
  return out;
}

function emptyReport(): IScaffoldCoverageReport {
  return {
    schema: SCAFFOLD_COVERAGE_SCHEMA,
    generatedAt: new Date().toISOString(),
    axes: [],
    confidence: 0,
    grade: CoverageGrade.Missing,
    missing: [],
    suggestedAdditions: [],
    nextCommands: [
      'Usage: shrk coverage scaffolds --task "<task>" | --domain <domain>',
    ],
  };
}

export function renderScaffoldCoverageMarkdown(report: IScaffoldCoverageReport): string {
  const lines: string[] = [];
  lines.push('# Scaffold coverage');
  if (report.task) lines.push(`Task: \`${report.task}\``);
  if (report.domain) lines.push(`Domain: \`${report.domain}\``);
  lines.push('');
  lines.push(`- grade: **${report.grade}**`);
  lines.push(`- confidence: ${(report.confidence * 100).toFixed(0)}%`);
  lines.push(`- matched axes: ${report.axes.filter((a) => a.matched).length} / ${report.axes.length}`);
  lines.push('');
  lines.push('## Axes');
  for (const a of report.axes) {
    const mark = a.matched ? 'yes' : 'no';
    lines.push(`- **${a.axis}**: ${mark} (count=${a.matchCount}${a.topIds.length > 0 ? ', top=' + a.topIds.slice(0, 3).join(', ') : ''})`);
  }
  if (report.missing.length > 0) {
    lines.push('');
    lines.push('## Missing pieces');
    for (const m of report.missing) lines.push(`- ${m}`);
  }
  if (report.suggestedAdditions.length > 0) {
    lines.push('');
    lines.push('## Suggested additions');
    for (const s of report.suggestedAdditions) lines.push(`- ${s}`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('');
    lines.push('## Next commands');
    for (const c of report.nextCommands) lines.push(`- \`${c}\``);
  }
  return lines.join('\n') + '\n';
}
