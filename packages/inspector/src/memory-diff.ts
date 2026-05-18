/**
 * Memory diff + drift.
 *
 * Compare two `IRepositoryMemoryIndex` snapshots to surface what got worse,
 * what got better, and overall trend. Pure local, no network.
 *
 * History storage lives under `.sharkcraft/memory/history/<ts>-memory.json`.
 * `shrk memory build --write-snapshot` writes one each time.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  memoryDir,
  type IMemoryDiagnosticEntry,
  type IMemoryFileEntry,
  type IRepositoryMemoryIndex,
} from './repo-memory.ts';

export const MEMORY_DIFF_SCHEMA = 'sharkcraft.memory-diff/v1';

export enum MemoryRiskTrend {
  Improving = 'improving',
  Stable = 'stable',
  Worsening = 'worsening',
  Unknown = 'unknown',
}

export interface IMemoryFileDelta {
  path: string;
  beforeScore: number;
  afterScore: number;
  delta: number;
}

export interface IMemoryDiagnosticDelta {
  code: string;
  beforeCount: number;
  afterCount: number;
  delta: number;
}

export interface IMemoryDiffReport {
  schema: typeof MEMORY_DIFF_SCHEMA;
  generatedAt: string;
  hasPrevious: boolean;
  riskTrend: MemoryRiskTrend;
  beforeGeneratedAt?: string;
  afterGeneratedAt: string;
  totalScoreBefore: number;
  totalScoreAfter: number;
  totalScoreDelta: number;
  newRiskyFiles: readonly IMemoryFileEntry[];
  resolvedRiskyFiles: readonly IMemoryFileEntry[];
  worseningFiles: readonly IMemoryFileDelta[];
  improvingFiles: readonly IMemoryFileDelta[];
  newRecurringDiagnostics: readonly IMemoryDiagnosticEntry[];
  resolvedDiagnostics: readonly IMemoryDiagnosticEntry[];
  diagnosticDeltas: readonly IMemoryDiagnosticDelta[];
  newPlanConflicts: readonly string[];
  newFailedValidationCommands: readonly string[];
  newRecurringBoundaryViolations: readonly string[];
  newRecurringPolicyViolations: readonly string[];
  newPackIssues: readonly string[];
  changedTopConstructs: readonly { id: string; beforeWeight: number; afterWeight: number; delta: number }[];
  suggestedActions: readonly string[];
  notes: readonly string[];
}

function scoreFile(f: IMemoryFileEntry): number {
  return f.touchCount + f.conflictCount * 4 + f.failedValidationCount * 3 + f.warningCount;
}

function diffArrayOnly<T extends string>(after: readonly T[], before: readonly T[]): T[] {
  const set = new Set<string>(before);
  return after.filter((x) => !set.has(x));
}

export function diffMemoryIndex(
  before: IRepositoryMemoryIndex | null,
  after: IRepositoryMemoryIndex,
): IMemoryDiffReport {
  if (!before) {
    return {
      schema: MEMORY_DIFF_SCHEMA,
      generatedAt: new Date().toISOString(),
      hasPrevious: false,
      riskTrend: MemoryRiskTrend.Unknown,
      afterGeneratedAt: after.generatedAt,
      totalScoreBefore: 0,
      totalScoreAfter: after.files.reduce((sum, f) => sum + scoreFile(f), 0),
      totalScoreDelta: after.files.reduce((sum, f) => sum + scoreFile(f), 0),
      newRiskyFiles: after.files.slice(0, 20),
      resolvedRiskyFiles: [],
      worseningFiles: [],
      improvingFiles: [],
      newRecurringDiagnostics: after.diagnostics.slice(0, 20),
      resolvedDiagnostics: [],
      diagnosticDeltas: [],
      newPlanConflicts: [...after.plansWithConflicts],
      newFailedValidationCommands: [...after.failedValidationCommands],
      newRecurringBoundaryViolations: [...after.boundaryViolationsRecurring],
      newRecurringPolicyViolations: [...after.policyViolationsRecurring],
      newPackIssues: [...after.packIssues],
      changedTopConstructs: [],
      suggestedActions: [
        'No previous snapshot — run `shrk memory build --write-snapshot` regularly to enable drift tracking.',
      ],
      notes: ['No previous memory snapshot available.'],
    };
  }

  const beforeByPath = new Map(before.files.map((f) => [f.path, f]));
  const afterByPath = new Map(after.files.map((f) => [f.path, f]));

  const newRiskyFiles: IMemoryFileEntry[] = [];
  const resolvedRiskyFiles: IMemoryFileEntry[] = [];
  const worseningFiles: IMemoryFileDelta[] = [];
  const improvingFiles: IMemoryFileDelta[] = [];

  for (const f of after.files) {
    const prev = beforeByPath.get(f.path);
    if (!prev) {
      newRiskyFiles.push(f);
      continue;
    }
    const beforeScore = scoreFile(prev);
    const afterScore = scoreFile(f);
    if (afterScore > beforeScore) {
      worseningFiles.push({ path: f.path, beforeScore, afterScore, delta: afterScore - beforeScore });
    } else if (afterScore < beforeScore) {
      improvingFiles.push({ path: f.path, beforeScore, afterScore, delta: afterScore - beforeScore });
    }
  }
  for (const f of before.files) {
    if (!afterByPath.has(f.path)) resolvedRiskyFiles.push(f);
  }

  const beforeDiag = new Map(before.diagnostics.map((d) => [d.code, d]));
  const afterDiag = new Map(after.diagnostics.map((d) => [d.code, d]));
  const newRecurringDiagnostics: IMemoryDiagnosticEntry[] = [];
  const resolvedDiagnostics: IMemoryDiagnosticEntry[] = [];
  const diagnosticDeltas: IMemoryDiagnosticDelta[] = [];
  for (const d of after.diagnostics) {
    const prev = beforeDiag.get(d.code);
    if (!prev) newRecurringDiagnostics.push(d);
    else if (prev.count !== d.count)
      diagnosticDeltas.push({ code: d.code, beforeCount: prev.count, afterCount: d.count, delta: d.count - prev.count });
  }
  for (const d of before.diagnostics) {
    if (!afterDiag.has(d.code)) resolvedDiagnostics.push(d);
  }

  const newPlanConflicts = diffArrayOnly(after.plansWithConflicts, before.plansWithConflicts);
  const newFailedValidationCommands = diffArrayOnly(after.failedValidationCommands, before.failedValidationCommands);
  const newRecurringBoundaryViolations = diffArrayOnly(after.boundaryViolationsRecurring, before.boundaryViolationsRecurring);
  const newRecurringPolicyViolations = diffArrayOnly(after.policyViolationsRecurring, before.policyViolationsRecurring);
  const newPackIssues = diffArrayOnly(after.packIssues, before.packIssues);

  const beforeConstructs = new Map(before.highRiskConstructs.map((c) => [c.id, c.weight]));
  const changedTopConstructs: { id: string; beforeWeight: number; afterWeight: number; delta: number }[] = [];
  for (const c of after.highRiskConstructs) {
    const prev = beforeConstructs.get(c.id) ?? 0;
    if (prev !== c.weight) changedTopConstructs.push({ id: c.id, beforeWeight: prev, afterWeight: c.weight, delta: c.weight - prev });
  }

  const totalScoreBefore = before.files.reduce((sum, f) => sum + scoreFile(f), 0);
  const totalScoreAfter = after.files.reduce((sum, f) => sum + scoreFile(f), 0);
  const totalScoreDelta = totalScoreAfter - totalScoreBefore;

  // Trend: weighted by both file score and new diagnostics/conflicts.
  const worseSignals =
    newRiskyFiles.length * 2 +
    worseningFiles.length +
    newRecurringDiagnostics.length * 2 +
    newPlanConflicts.length * 3 +
    newRecurringBoundaryViolations.length * 2 +
    newRecurringPolicyViolations.length * 2 +
    Math.max(0, totalScoreDelta);
  const betterSignals =
    resolvedRiskyFiles.length * 2 +
    improvingFiles.length +
    resolvedDiagnostics.length * 2 +
    Math.max(0, -totalScoreDelta);

  let riskTrend = MemoryRiskTrend.Stable;
  if (worseSignals > betterSignals * 1.5 && worseSignals > 2) riskTrend = MemoryRiskTrend.Worsening;
  else if (betterSignals > worseSignals * 1.5 && betterSignals > 2) riskTrend = MemoryRiskTrend.Improving;

  const suggestedActions: string[] = [];
  if (newRiskyFiles.length > 0) suggestedActions.push(`Review newly risky files: ${newRiskyFiles.slice(0, 3).map((f) => f.path).join(', ')}.`);
  if (newPlanConflicts.length > 0) suggestedActions.push(`Inspect ${newPlanConflicts.length} new plan(s) with conflicts.`);
  if (newRecurringBoundaryViolations.length > 0) suggestedActions.push(`New recurring boundary violations: ${newRecurringBoundaryViolations.join(', ')}.`);
  if (newRecurringPolicyViolations.length > 0) suggestedActions.push(`New recurring policy violations: ${newRecurringPolicyViolations.join(', ')}.`);
  if (newPackIssues.length > 0) suggestedActions.push(`Pack issues regressed: ${newPackIssues.join(', ')}.`);
  if (riskTrend === MemoryRiskTrend.Worsening) suggestedActions.push('Trend worsening — consider scheduling cleanup or freezing risky changes.');

  return {
    schema: MEMORY_DIFF_SCHEMA,
    generatedAt: new Date().toISOString(),
    hasPrevious: true,
    riskTrend,
    beforeGeneratedAt: before.generatedAt,
    afterGeneratedAt: after.generatedAt,
    totalScoreBefore,
    totalScoreAfter,
    totalScoreDelta,
    newRiskyFiles: newRiskyFiles.slice(0, 30),
    resolvedRiskyFiles: resolvedRiskyFiles.slice(0, 30),
    worseningFiles: worseningFiles.sort((a, b) => b.delta - a.delta).slice(0, 30),
    improvingFiles: improvingFiles.sort((a, b) => a.delta - b.delta).slice(0, 30),
    newRecurringDiagnostics: newRecurringDiagnostics.slice(0, 30),
    resolvedDiagnostics: resolvedDiagnostics.slice(0, 30),
    diagnosticDeltas: diagnosticDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 30),
    newPlanConflicts,
    newFailedValidationCommands,
    newRecurringBoundaryViolations,
    newRecurringPolicyViolations,
    newPackIssues,
    changedTopConstructs: changedTopConstructs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 30),
    suggestedActions,
    notes: [],
  };
}

export function memoryHistoryDir(projectRoot: string): string {
  return nodePath.join(memoryDir(projectRoot), 'history');
}

export function writeMemorySnapshot(projectRoot: string, index: IRepositoryMemoryIndex): string {
  const dir = memoryHistoryDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const stamp = (index.generatedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const file = nodePath.join(dir, `${stamp}-memory.json`);
  writeFileSync(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return file;
}

export function listMemorySnapshots(projectRoot: string): string[] {
  const dir = memoryHistoryDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('-memory.json'))
    .map((f) => nodePath.join(dir, f))
    .sort();
}

export function loadMemorySnapshot(file: string): IRepositoryMemoryIndex | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as IRepositoryMemoryIndex;
  } catch {
    return null;
  }
}

export function latestMemorySnapshot(projectRoot: string): IRepositoryMemoryIndex | null {
  const list = listMemorySnapshots(projectRoot);
  if (list.length === 0) return null;
  return loadMemorySnapshot(list[list.length - 1]!);
}

export function renderMemoryDiffText(d: IMemoryDiffReport): string {
  let out = `=== Memory diff ===\n`;
  out += `  trend            ${d.riskTrend}\n`;
  out += `  before generated ${d.beforeGeneratedAt ?? '(none)'}\n`;
  out += `  after generated  ${d.afterGeneratedAt}\n`;
  out += `  score before     ${d.totalScoreBefore}\n`;
  out += `  score after      ${d.totalScoreAfter}  (Δ ${d.totalScoreDelta >= 0 ? '+' : ''}${d.totalScoreDelta})\n\n`;
  if (d.newRiskyFiles.length) {
    out += `Newly risky files:\n`;
    for (const f of d.newRiskyFiles.slice(0, 10)) out += `  + ${f.path} (touches=${f.touchCount}, conflicts=${f.conflictCount})\n`;
    out += `\n`;
  }
  if (d.resolvedRiskyFiles.length) {
    out += `Resolved risky files:\n`;
    for (const f of d.resolvedRiskyFiles.slice(0, 10)) out += `  - ${f.path}\n`;
    out += `\n`;
  }
  if (d.worseningFiles.length) {
    out += `Worsening files:\n`;
    for (const f of d.worseningFiles.slice(0, 10)) out += `  ↑ ${f.path}  ${f.beforeScore} → ${f.afterScore} (+${f.delta})\n`;
    out += `\n`;
  }
  if (d.improvingFiles.length) {
    out += `Improving files:\n`;
    for (const f of d.improvingFiles.slice(0, 10)) out += `  ↓ ${f.path}  ${f.beforeScore} → ${f.afterScore} (${f.delta})\n`;
    out += `\n`;
  }
  if (d.newRecurringDiagnostics.length) {
    out += `New recurring diagnostics: ${d.newRecurringDiagnostics.map((x) => x.code).join(', ')}\n\n`;
  }
  if (d.resolvedDiagnostics.length) {
    out += `Resolved diagnostics: ${d.resolvedDiagnostics.map((x) => x.code).join(', ')}\n\n`;
  }
  if (d.newPlanConflicts.length) out += `New plan conflicts: ${d.newPlanConflicts.length}\n\n`;
  if (d.newRecurringBoundaryViolations.length) out += `New recurring boundary violations: ${d.newRecurringBoundaryViolations.join(', ')}\n\n`;
  if (d.newRecurringPolicyViolations.length) out += `New recurring policy violations: ${d.newRecurringPolicyViolations.join(', ')}\n\n`;
  if (d.newPackIssues.length) out += `New pack issues: ${d.newPackIssues.join(', ')}\n\n`;
  if (d.suggestedActions.length) {
    out += `Suggested actions:\n`;
    for (const a of d.suggestedActions) out += `  • ${a}\n`;
    out += `\n`;
  }
  if (d.notes.length) {
    out += `Notes:\n`;
    for (const n of d.notes) out += `  • ${n}\n`;
  }
  return out;
}

export function renderMemoryDiffMarkdown(d: IMemoryDiffReport): string {
  let out = `# Memory diff\n\n`;
  out += `- **trend**: ${d.riskTrend}\n`;
  out += `- **before generated**: ${d.beforeGeneratedAt ?? '(none)'}\n`;
  out += `- **after generated**: ${d.afterGeneratedAt}\n`;
  out += `- **score**: ${d.totalScoreBefore} → ${d.totalScoreAfter} (Δ ${d.totalScoreDelta >= 0 ? '+' : ''}${d.totalScoreDelta})\n\n`;
  if (d.newRiskyFiles.length) {
    out += `## Newly risky files\n`;
    for (const f of d.newRiskyFiles.slice(0, 15)) out += `- \`${f.path}\` — touches ${f.touchCount}, conflicts ${f.conflictCount}\n`;
    out += `\n`;
  }
  if (d.resolvedRiskyFiles.length) {
    out += `## Resolved risky files\n`;
    for (const f of d.resolvedRiskyFiles.slice(0, 15)) out += `- \`${f.path}\`\n`;
    out += `\n`;
  }
  if (d.worseningFiles.length) {
    out += `## Worsening files\n| File | Before | After | Δ |\n| --- | --- | --- | --- |\n`;
    for (const f of d.worseningFiles.slice(0, 15)) out += `| \`${f.path}\` | ${f.beforeScore} | ${f.afterScore} | +${f.delta} |\n`;
    out += `\n`;
  }
  if (d.improvingFiles.length) {
    out += `## Improving files\n| File | Before | After | Δ |\n| --- | --- | --- | --- |\n`;
    for (const f of d.improvingFiles.slice(0, 15)) out += `| \`${f.path}\` | ${f.beforeScore} | ${f.afterScore} | ${f.delta} |\n`;
    out += `\n`;
  }
  if (d.suggestedActions.length) {
    out += `## Suggested actions\n`;
    for (const a of d.suggestedActions) out += `- ${a}\n`;
    out += `\n`;
  }
  return out;
}
