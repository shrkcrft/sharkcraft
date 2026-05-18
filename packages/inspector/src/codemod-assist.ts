/**
 * Codemod-assist (NOT a codemod engine).
 *
 * Inventory + plan + checklist for a rule's cleanup work. Source is never
 * rewritten by default. The output:
 *   - lists affected files (when a rule has a custom-check that produced
 *     a parsed report, or when the user passes a target list).
 *   - groups by risk (low/medium/high) using consumer counts when an
 *     impact-analysis hint is supplied.
 *   - emits a project-script template under `.sharkcraft/fixes/` when
 *     asked.
 *   - clearly states "this needs manual / ts-morph / jscodeshift work
 *     for the rewrite step".
 *
 * Hard rules:
 *   - No source mutation.
 *   - No spawning of external tools.
 *   - The "checklist" is text — not a workflow runner.
 */
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { ICustomCheckReport } from './custom-checks.ts';

export const CODEMOD_ASSIST_SCHEMA = 'sharkcraft.codemod-assist/v1';

export enum CodemodRiskBand {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Unknown = 'unknown',
}

export interface ICodemodAffectedFile {
  path: string;
  /** Unique consumers, from impact-analysis when available. */
  consumerCount?: number;
  /** Free-form notes copied from the check report. */
  note?: string;
  /** Risk band determined by the planner. */
  risk: CodemodRiskBand;
  /** Suggested first action — copy/rewrite/delete/manual. */
  suggestedAction: 'rewrite' | 'delete' | 'manual' | 'review';
}

export interface ICodemodAssistInput {
  rule: IKnowledgeEntry;
  /**
   * Optional list of files that match the rule's check (typically
   * supplied from a parsed `sharkcraft.custom-check/v1` report).
   */
  affectedFiles?: readonly { path: string; note?: string }[];
  /** Map of file path → unique consumer count (impact-analysis output). */
  consumerCounts?: ReadonlyMap<string, number>;
  /**
   * Free-form recommended external tool. Defaults derived from rule tags.
   */
  recommendedExternalTool?: string;
}

export interface ICodemodAssistChecklistItem {
  id: string;
  description: string;
  /** What command should the agent / human run for this item. */
  suggestedCommand?: string;
  /** Risk band for this item. */
  risk: CodemodRiskBand;
}

export interface ICodemodAssistReport {
  schema: typeof CODEMOD_ASSIST_SCHEMA;
  generatedAt: string;
  ruleId: string;
  ruleTitle: string;
  /** What the engine can validate locally. */
  enginePromise: readonly string[];
  /** What it cannot do (clearly stated). */
  engineLimits: readonly string[];
  affectedFiles: readonly ICodemodAffectedFile[];
  riskGroups: {
    low: readonly string[];
    medium: readonly string[];
    high: readonly string[];
    unknown: readonly string[];
  };
  recommendedExternalTool: string;
  checklist: readonly ICodemodAssistChecklistItem[];
  /** Optional project-script template the agent can save under .sharkcraft/fixes/. */
  scriptTemplate: { path: string; body: string };
  /** Suggested validation commands after the rewrite is done. */
  validationCommands: readonly string[];
}

const DELETE_TAGS = new Set(['delete', 'cleanup', 'noreexport', 'no-reexport', 're-export', 'reexport-proxy']);
const REWRITE_TAGS = new Set(['rewrite', 'refactor', 'imports', 'rename']);

function defaultExternalTool(rule: IKnowledgeEntry, fallback?: string): string {
  if (fallback) return fallback;
  const tagsLower = new Set(rule.tags.map((t) => t.toLowerCase()));
  if (tagsLower.has('imports') || rule.id.toLowerCase().includes('reexport')) {
    return 'ts-morph or jscodeshift (manual rewrite of consumers)';
  }
  if (tagsLower.has('lint') || tagsLower.has('style')) {
    return 'eslint custom rule + autofix (when safe)';
  }
  if (tagsLower.has('boundaries') || tagsLower.has('architecture')) {
    return 'manual review + targeted rename via shrk knowledge rename-symbol';
  }
  return 'ts-morph (or manual edits when scope is small)';
}

function bandForFile(consumerCount?: number): CodemodRiskBand {
  if (consumerCount === undefined) return CodemodRiskBand.Unknown;
  if (consumerCount === 0) return CodemodRiskBand.Low;
  if (consumerCount <= 5) return CodemodRiskBand.Medium;
  return CodemodRiskBand.High;
}

function suggestedActionForRule(rule: IKnowledgeEntry): 'rewrite' | 'delete' | 'manual' | 'review' {
  const lower = rule.id.toLowerCase();
  if (lower.includes('reexport') || lower.includes('proxy')) return 'delete';
  const tags = new Set(rule.tags.map((t) => t.toLowerCase()));
  for (const t of tags) if (DELETE_TAGS.has(t)) return 'delete';
  for (const t of tags) if (REWRITE_TAGS.has(t)) return 'rewrite';
  return 'review';
}

function fileSafeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

function buildScriptTemplate(rule: IKnowledgeEntry, suggestedAction: string): {
  path: string;
  body: string;
} {
  const safeId = fileSafeId(rule.id);
  const path = `.sharkcraft/fixes/codemod-${safeId}.template.ts`;
  const body = `/**
 * Codemod-assist template for "${rule.id}".
 *
 * Auto-generated by \`shrk codemod plan --rule ${rule.id}\`. The engine
 * does NOT rewrite source. This file is a starting point for the
 * project-script that does. Suggested first action: ${suggestedAction}.
 *
 * Convention: the script should write a sharkcraft.custom-check/v1
 * report to .sharkcraft/reports/custom-check-${safeId}.json so
 * \`shrk checks run ${safeId}\` can parse it.
 */
import { writeFileSync } from 'node:fs';

const REPORT_PATH = '.sharkcraft/reports/custom-check-${safeId}.json';

function findOffenders(): string[] {
  // TODO: walk the repo and return paths matching the rule shape.
  return [];
}

function planRewrite(file: string): { ok: boolean; message: string } {
  // TODO: open the file with ts-morph / jscodeshift / regex and decide.
  return { ok: true, message: \`would ${suggestedAction} \${file}\` };
}

function main(): void {
  const offenders = findOffenders();
  const findings = offenders.map((file) => {
    const plan = planRewrite(file);
    return {
      severity: plan.ok ? 'info' : 'error',
      file,
      message: plan.message,
      suggestedAction: '${suggestedAction}',
      safeToAutoFix: false,
    };
  });
  const report = {
    schema: 'sharkcraft.custom-check/v1',
    checkId: '${safeId}',
    ruleId: '${rule.id}',
    generatedAt: new Date().toISOString(),
    status: findings.some((f) => f.severity === 'error') ? 'fail' : findings.length > 0 ? 'warn' : 'pass',
    findings,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\\n');
}

main();
`;
  return { path, body };
}

export function buildCodemodAssistReport(input: ICodemodAssistInput): ICodemodAssistReport {
  const rule = input.rule;
  const suggestion = suggestedActionForRule(rule);
  const externalTool = defaultExternalTool(rule, input.recommendedExternalTool);
  const counts = input.consumerCounts ?? new Map<string, number>();
  const affected: ICodemodAffectedFile[] = (input.affectedFiles ?? []).map((f) => {
    const consumerCount = counts.get(f.path);
    return {
      path: f.path,
      note: f.note,
      consumerCount,
      risk: bandForFile(consumerCount),
      suggestedAction: suggestion,
    };
  });
  const groups = {
    low: affected.filter((a) => a.risk === CodemodRiskBand.Low).map((a) => a.path),
    medium: affected.filter((a) => a.risk === CodemodRiskBand.Medium).map((a) => a.path),
    high: affected.filter((a) => a.risk === CodemodRiskBand.High).map((a) => a.path),
    unknown: affected.filter((a) => a.risk === CodemodRiskBand.Unknown).map((a) => a.path),
  };
  const checklist: ICodemodAssistChecklistItem[] = [];
  let counter = 1;
  if (groups.low.length > 0) {
    checklist.push({
      id: `codemod-${counter++}`,
      risk: CodemodRiskBand.Low,
      description: `Low-risk: ${groups.low.length} file(s) with no consumers — safe to ${suggestion} first.`,
      suggestedCommand: `shrk codemod inventory --rule ${rule.id} --risk low`,
    });
  }
  if (groups.medium.length > 0) {
    checklist.push({
      id: `codemod-${counter++}`,
      risk: CodemodRiskBand.Medium,
      description: `Medium-risk: ${groups.medium.length} file(s) with 1–5 consumers — ${suggestion} after re-import sweep.`,
      suggestedCommand: `shrk impact analyze --files ${groups.medium.slice(0, 3).join(',')}`,
    });
  }
  if (groups.high.length > 0) {
    checklist.push({
      id: `codemod-${counter++}`,
      risk: CodemodRiskBand.High,
      description: `High-risk: ${groups.high.length} file(s) with >5 consumers — schedule with owners before rewriting.`,
      suggestedCommand: `shrk impact analyze --files ${groups.high.slice(0, 3).join(',')}`,
    });
  }
  if (groups.unknown.length > 0) {
    checklist.push({
      id: `codemod-${counter++}`,
      risk: CodemodRiskBand.Unknown,
      description: `Unknown risk: ${groups.unknown.length} file(s) — run impact-analysis to fill in consumer counts.`,
      suggestedCommand: `shrk impact analyze --files ${groups.unknown.slice(0, 3).join(',')}`,
    });
  }
  checklist.push({
    id: `codemod-${counter++}`,
    risk: CodemodRiskBand.Unknown,
    description: `Use ${externalTool} for the actual rewrite — engine does not touch source.`,
  });
  checklist.push({
    id: `codemod-${counter++}`,
    risk: CodemodRiskBand.Unknown,
    description: 'After rewriting, re-run the rule\'s custom check + boundaries + tests.',
    suggestedCommand: `shrk checks run codemod-${fileSafeId(rule.id)} --execute`,
  });
  const validation = [
    'shrk doctor',
    'shrk check boundaries',
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
  ];
  return {
    schema: CODEMOD_ASSIST_SCHEMA,
    generatedAt: new Date().toISOString(),
    ruleId: rule.id,
    ruleTitle: rule.title,
    enginePromise: [
      'inventory affected files (when a check report or target list is supplied)',
      'group by risk via consumer count when impact-analysis output is provided',
      'suggest the rewrite strategy and the external tool',
      'emit a project-script template under .sharkcraft/fixes/',
      'list the validation commands to run after rewrite',
    ],
    engineLimits: [
      'no source rewrite — the engine never edits the offending files',
      'no AST traversal — use ts-morph / jscodeshift for safe rewrites',
      'no spawn of external tools — the agent runs them after review',
      'consumer counts are absent when impact-analysis output is not provided',
    ],
    affectedFiles: affected,
    riskGroups: groups,
    recommendedExternalTool: externalTool,
    checklist,
    scriptTemplate: buildScriptTemplate(rule, suggestion),
    validationCommands: validation,
  };
}

export function affectedFromCheckReport(report: ICustomCheckReport): readonly { path: string; note?: string }[] {
  const out: { path: string; note?: string }[] = [];
  for (const f of report.findings) {
    if (!f.file) continue;
    out.push({ path: f.file, note: f.message });
  }
  return out;
}

export function renderCodemodAssistMarkdown(report: ICodemodAssistReport): string {
  const lines: string[] = [];
  lines.push(`# Codemod-assist for ${report.ruleId}`);
  lines.push('');
  lines.push(`> ${report.ruleTitle}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## What the engine can do');
  for (const p of report.enginePromise) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## What the engine cannot do');
  for (const p of report.engineLimits) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## Affected files');
  if (report.affectedFiles.length === 0) {
    lines.push('_(no files supplied — pass `--from-report <path>` or `--targets a,b,c`)_');
  } else {
    lines.push('| Risk | Consumers | File | Note |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of report.affectedFiles) {
      lines.push(`| ${f.risk} | ${f.consumerCount ?? '?'} | \`${f.path}\` | ${f.note ?? ''} |`);
    }
  }
  lines.push('');
  lines.push(`## Recommended external tool: ${report.recommendedExternalTool}`);
  lines.push('');
  lines.push('## Checklist');
  for (const c of report.checklist) {
    lines.push(`- [ ] (${c.risk}) ${c.description}`);
    if (c.suggestedCommand) lines.push(`        $ ${c.suggestedCommand}`);
  }
  lines.push('');
  lines.push('## Validation commands (after rewrite)');
  for (const v of report.validationCommands) lines.push(`- $ ${v}`);
  lines.push('');
  lines.push('## Project-script template (preview)');
  lines.push('Save this under `' + report.scriptTemplate.path + '` and customise:');
  lines.push('');
  lines.push('```typescript');
  lines.push(report.scriptTemplate.body);
  lines.push('```');
  return lines.join('\n') + '\n';
}
