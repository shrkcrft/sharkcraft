/**
 * Per-task risk model.
 *
 * Given a task string (plus optional file hints), compute a deterministic
 * per-task risk report. Builds on:
 * - change intent (kind / domain / required-human-review)
 * - impact analysis (direct/transitive dependents, boundary concerns,
 *   policy concerns, ownership impact, missing tests)
 * - architecture map signals (high fan-in / fan-out files)
 *
 * Pure data — read-only. No model calls, no embeddings, no telemetry.
 */
import { existsSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  classifyChangeIntent,
  ChangeIntentKind,
  type IChangeIntent,
} from './change-intent.ts';
import { loadRepositoryMemory, type IRepositoryMemoryIndex } from './repo-memory.ts';
import {
  analyzeImpact,
  ImpactInputKind,
  type IImpactAnalysis,
} from './impact-analysis.ts';
import { buildArchitectureMap } from './architecture-map.ts';
import { getChangedFiles } from './git-helpers.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const TASK_RISK_SCHEMA = 'sharkcraft.task-risk/v1';

export enum TaskRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Critical = 'critical',
}

export interface ITaskRiskReason {
  code: string;
  message: string;
  weight: number;
}

export interface ITaskRiskMemorySignal {
  code: string;
  message: string;
  weight: number;
  source: 'file' | 'diagnostic' | 'construct' | 'boundary' | 'policy' | 'plan' | 'pack';
}

export interface ITaskRiskMemoryReport {
  /** True if no memory index was found. */
  missing: boolean;
  /** True if the memory index is older than 30 days. */
  stale: boolean;
  /** ISO timestamp when the loaded index was generated. */
  indexGeneratedAt?: string;
  /** Raw memory adjustment before cap. */
  rawScore: number;
  /** Final adjustment after cap. */
  score: number;
  /** Memory-derived risk level (low/medium/high/critical). */
  level: TaskRiskLevel;
  /** Reasons that fired during memory scoring. */
  reasons: readonly ITaskRiskReason[];
  /** Each individual signal (for transparency / explainability). */
  signals: readonly ITaskRiskMemorySignal[];
  /** True if the cap was applied. */
  capped: boolean;
  /** Cap value used. */
  cap: number;
}

export interface ITaskRiskReport {
  schema: typeof TASK_RISK_SCHEMA;
  generatedAt: string;
  task: string;
  intent: IChangeIntent;
  riskLevel: TaskRiskLevel;
  score: number;
  reasons: readonly ITaskRiskReason[];
  affectedFiles: readonly string[];
  affectedConstructs: readonly string[];
  highFanInFiles: readonly string[];
  highFanOutFiles: readonly string[];
  ownershipGaps: readonly string[];
  testGaps: readonly string[];
  boundaryConcerns: readonly string[];
  policyConcerns: readonly string[];
  recommendedReviewCommands: readonly string[];
  humanApprovalRequired: boolean;
  /** Pre-memory base score. Equals `score` when memory wasn't applied. */
  baseScore: number;
  /** Pre-memory base level. */
  baseRiskLevel: TaskRiskLevel;
  /** Memory adjustment applied, when --include-memory or includeMemory is set. */
  memory?: ITaskRiskMemoryReport;
  /** Convenience — same as `score` post-memory. */
  adjustedScore: number;
  /** Convenience — same as `riskLevel` post-memory. */
  adjustedRiskLevel: TaskRiskLevel;
}

export interface IBuildTaskRiskOptions {
  files?: readonly string[];
  since?: string;
  staged?: boolean;
  /** When true, the memory index (if present) influences the score. */
  includeMemory?: boolean;
}

const HIGH_FAN_THRESHOLD = 40;

/** Maximum risk score added by memory adjustment. */
const MEMORY_SCORE_CAP = 14;
/** Index older than this is considered stale (days). */
const MEMORY_STALE_DAYS = 30;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function ageInDaysOrInfinity(iso: string | undefined): number {
  if (!iso) return Infinity;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return Infinity;
  return (Date.now() - ts) / (1000 * 60 * 60 * 24);
}

interface IMemoryScoreContext {
  taskTokens: readonly string[];
  affectedFiles: readonly string[];
  affectedConstructs: readonly string[];
}

function buildMemoryReport(
  index: IRepositoryMemoryIndex | null,
  ctx: IMemoryScoreContext,
): ITaskRiskMemoryReport {
  if (!index || index.sourceCount === 0) {
    return {
      missing: true,
      stale: false,
      rawScore: 0,
      score: 0,
      level: TaskRiskLevel.Low,
      reasons: [],
      signals: [],
      capped: false,
      cap: MEMORY_SCORE_CAP,
    };
  }
  const stale = ageInDaysOrInfinity(index.generatedAt) > MEMORY_STALE_DAYS;
  const signals: ITaskRiskMemorySignal[] = [];
  const reasons: ITaskRiskReason[] = [];
  let raw = 0;

  // Helper to match historical files against affected files.
  const fileSet = new Set(ctx.affectedFiles.map((f) => f.toLowerCase()));

  // Files frequently in conflicts or failed validations.
  let conflictFileHits = 0;
  let failedValHits = 0;
  let warningHits = 0;
  let highTouchHits = 0;
  for (const f of index.files) {
    const key = f.path.toLowerCase();
    let touchesTask = false;
    if (fileSet.has(key)) touchesTask = true;
    else if (ctx.taskTokens.some((t) => key.includes(t))) touchesTask = true;
    if (!touchesTask) continue;
    if (f.conflictCount > 0) {
      conflictFileHits += 1;
      signals.push({
        code: 'memory-file-conflicts',
        message: `File historically conflicted (${f.conflictCount}×): ${f.path}`,
        weight: 2,
        source: 'file',
      });
    }
    if (f.failedValidationCount > 0) {
      failedValHits += 1;
      signals.push({
        code: 'memory-file-failed-validations',
        message: `File historically tied to failed validations: ${f.path}`,
        weight: 2,
        source: 'file',
      });
    }
    if (f.warningCount >= 2) {
      warningHits += 1;
      signals.push({
        code: 'memory-file-warnings',
        message: `File historically warned (${f.warningCount}×): ${f.path}`,
        weight: 1,
        source: 'file',
      });
    }
    if (f.touchCount >= 3 && f.conflictCount === 0 && f.failedValidationCount === 0 && f.warningCount === 0) {
      highTouchHits += 1;
      signals.push({
        code: 'memory-file-hot-touch',
        message: `Historically active file (${f.touchCount}×): ${f.path}`,
        weight: 1,
        source: 'file',
      });
    }
  }
  if (highTouchHits > 0) {
    const w = Math.min(highTouchHits, 4);
    raw += w;
    reasons.push({
      code: 'memory-touch-hotspot',
      message: `${highTouchHits} historically active file(s) overlap the task.`,
      weight: w,
    });
  }
  if (conflictFileHits > 0) {
    const w = Math.min(conflictFileHits, 3) * 2;
    raw += w;
    reasons.push({
      code: 'memory-conflict-hotspot',
      message: `${conflictFileHits} historically conflict-prone file(s) overlap with the task.`,
      weight: w,
    });
  }
  if (failedValHits > 0) {
    const w = Math.min(failedValHits, 3) * 2;
    raw += w;
    reasons.push({
      code: 'memory-failed-validation-hotspot',
      message: `${failedValHits} file(s) overlapping the task have failed validations in history.`,
      weight: w,
    });
  }
  if (warningHits > 0) {
    const w = Math.min(warningHits, 3);
    raw += w;
    reasons.push({
      code: 'memory-warning-hotspot',
      message: `${warningHits} file(s) overlapping the task carry recurring warnings.`,
      weight: w,
    });
  }

  // Recurring boundary violations relevant to the task.
  for (const ruleId of index.boundaryViolationsRecurring) {
    if (
      ctx.taskTokens.some((t) => ruleId.toLowerCase().includes(t)) ||
      ctx.affectedConstructs.some((c) => ruleId.toLowerCase().includes(c.toLowerCase()))
    ) {
      signals.push({
        code: 'memory-recurring-boundary',
        message: `Recurring boundary rule overlaps: ${ruleId}`,
        weight: 2,
        source: 'boundary',
      });
      raw += 2;
      reasons.push({
        code: 'memory-recurring-boundary',
        message: `Boundary rule "${ruleId}" has recurred historically and overlaps the task.`,
        weight: 2,
      });
    }
  }
  // Recurring policy violations relevant to the task.
  for (const id of index.policyViolationsRecurring) {
    if (ctx.taskTokens.some((t) => id.toLowerCase().includes(t))) {
      signals.push({
        code: 'memory-recurring-policy',
        message: `Recurring policy: ${id}`,
        weight: 2,
        source: 'policy',
      });
      raw += 2;
      reasons.push({
        code: 'memory-recurring-policy',
        message: `Policy "${id}" has recurred historically and overlaps the task.`,
        weight: 2,
      });
    }
  }

  // Recurring diagnostics overlapping the task.
  let diagnosticHits = 0;
  for (const d of index.diagnostics) {
    if (ctx.taskTokens.some((t) => d.code.toLowerCase().includes(t))) {
      diagnosticHits += 1;
      signals.push({
        code: 'memory-recurring-diagnostic',
        message: `Recurring diagnostic ${d.code} (×${d.count})`,
        weight: 1,
        source: 'diagnostic',
      });
    }
  }
  if (diagnosticHits > 0) {
    const w = Math.min(diagnosticHits, 3);
    raw += w;
    reasons.push({
      code: 'memory-recurring-diagnostics',
      message: `${diagnosticHits} historical diagnostic(s) overlap the task.`,
      weight: w,
    });
  }

  // Historically risky construct overlap.
  let constructHits = 0;
  for (const c of index.highRiskConstructs) {
    if (
      ctx.affectedConstructs.some((a) => a.toLowerCase() === c.id.toLowerCase()) ||
      ctx.taskTokens.some((t) => c.id.toLowerCase().includes(t))
    ) {
      constructHits += 1;
      signals.push({
        code: 'memory-construct-hotspot',
        message: `Historically active construct: ${c.id} (weight ${c.weight})`,
        weight: 1,
        source: 'construct',
      });
    }
  }
  if (constructHits > 0) {
    const w = Math.min(constructHits, 3);
    raw += w;
    reasons.push({
      code: 'memory-construct-hotspot',
      message: `${constructHits} historically active construct(s) overlap the task.`,
      weight: w,
    });
  }

  // Plans with conflicts when the task references templates.
  if (
    index.plansWithConflicts.length > 0 &&
    ctx.taskTokens.some((t) => /plan|template|update|apply/.test(t))
  ) {
    const w = Math.min(index.plansWithConflicts.length, 3);
    raw += w;
    reasons.push({
      code: 'memory-plans-conflict-history',
      message: `${index.plansWithConflicts.length} historical plan(s) had conflicts.`,
      weight: w,
    });
    signals.push({
      code: 'memory-plans-conflict-history',
      message: `${index.plansWithConflicts.length} historical plans had conflicts.`,
      weight: w,
      source: 'plan',
    });
  }

  // Pack issues — broad signal.
  if (index.packIssues.length > 0) {
    const w = Math.min(index.packIssues.length, 2);
    raw += w;
    reasons.push({
      code: 'memory-pack-issues',
      message: `${index.packIssues.length} pack(s) flagged in history.`,
      weight: w,
    });
    signals.push({
      code: 'memory-pack-issues',
      message: `${index.packIssues.length} pack(s) historically flagged.`,
      weight: w,
      source: 'pack',
    });
  }

  // Stale memory dampens influence.
  let score = raw;
  if (stale) {
    const before = score;
    score = Math.floor(score * 0.5);
    if (before !== score) {
      reasons.push({
        code: 'memory-stale',
        message: `Memory index is older than ${MEMORY_STALE_DAYS} days — adjustment halved.`,
        weight: score - before,
      });
    }
  }
  const capped = score > MEMORY_SCORE_CAP;
  if (capped) score = MEMORY_SCORE_CAP;

  // Map memory score to its own level (for explainability).
  const memLevel = classifyLevel(score);

  const out: ITaskRiskMemoryReport = {
    missing: false,
    stale,
    rawScore: raw,
    score,
    level: memLevel,
    reasons,
    signals,
    capped,
    cap: MEMORY_SCORE_CAP,
  };
  if (index.generatedAt) out.indexGeneratedAt = index.generatedAt;
  return out;
}


function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)].filter((x) => x.length > 0);
}

function classifyLevel(score: number): TaskRiskLevel {
  if (score >= 28) return TaskRiskLevel.Critical;
  if (score >= 16) return TaskRiskLevel.High;
  if (score >= 6) return TaskRiskLevel.Medium;
  return TaskRiskLevel.Low;
}

function intentBaseScore(intent: IChangeIntent): number {
  switch (intent.kind) {
    case ChangeIntentKind.Release:
    case ChangeIntentKind.Migration:
      return 12;
    case ChangeIntentKind.Architecture:
    case ChangeIntentKind.Policy:
      return 10;
    case ChangeIntentKind.Refactor:
      return 4;
    case ChangeIntentKind.Feature:
      return 3;
    case ChangeIntentKind.Bugfix:
      return 2;
    case ChangeIntentKind.Test:
    case ChangeIntentKind.Docs:
      return 0;
    default:
      return 1;
  }
}

function summarizeFanFiles(
  files: readonly { file: string; fanIn: number; fanOut: number }[],
): { highIn: string[]; highOut: string[] } {
  const highIn: string[] = [];
  const highOut: string[] = [];
  for (const f of files) {
    if (f.fanIn >= HIGH_FAN_THRESHOLD) highIn.push(f.file);
    if (f.fanOut >= HIGH_FAN_THRESHOLD) highOut.push(f.file);
  }
  return { highIn: highIn.slice(0, 10), highOut: highOut.slice(0, 10) };
}

function isLikelyTouching(file: string, target: string): boolean {
  return file === target || file.endsWith('/' + target) || target.endsWith('/' + file);
}

async function inferFilesFromContext(
  inspection: ISharkcraftInspection,
  options: IBuildTaskRiskOptions,
): Promise<string[]> {
  const out: string[] = [];
  if (options.files && options.files.length > 0) {
    for (const f of options.files) {
      const rel = f.startsWith(inspection.projectRoot)
        ? nodePath.relative(inspection.projectRoot, f)
        : f.replace(/^\.\/?/, '');
      out.push(rel.split(nodePath.sep).join('/'));
    }
  }
  if (options.since || options.staged) {
    try {
      const changed = getChangedFiles(inspection.projectRoot, {
        ...(options.since ? { since: options.since } : {}),
        ...(options.staged ? { staged: true } : {}),
      });
      for (const c of changed) out.push(c);
    } catch {
      /* best-effort */
    }
  }
  return unique(out).filter((f) =>
    existsSync(nodePath.join(inspection.projectRoot, f)) || /\.(ts|tsx|js|jsx|md|json)$/i.test(f),
  );
}

function inferConstructsFromIntent(
  intent: IChangeIntent,
  inspection: ISharkcraftInspection,
): string[] {
  const constructs = (inspection as unknown as {
    constructs?: { id: string; type: string }[];
  }).constructs;
  if (!constructs) return intent.likelyConstructs.slice(0, 10);
  const hit = new Set<string>(intent.likelyConstructs);
  for (const c of constructs) {
    if (intent.task.toLowerCase().includes(c.id.toLowerCase())) hit.add(c.id);
  }
  return [...hit].slice(0, 10);
}

export async function buildTaskRiskReport(
  task: string,
  inspection: ISharkcraftInspection,
  options: IBuildTaskRiskOptions = {},
): Promise<ITaskRiskReport> {
  const trimmed = task.trim();
  const intent = await classifyChangeIntent(trimmed, inspection);

  const files = await inferFilesFromContext(inspection, options);
  const impactInput: {
    task: string;
    files?: readonly string[];
    inputKind: ImpactInputKind;
  } = {
    task: trimmed,
    inputKind: files.length > 0 ? ImpactInputKind.Files : ImpactInputKind.Task,
  };
  if (files.length > 0) impactInput.files = files;
  let impact: IImpactAnalysis | null = null;
  try {
    impact = await analyzeImpact(inspection, impactInput);
  } catch {
    impact = null;
  }

  const arch = await buildArchitectureMap(inspection, { signals: true });

  const reasons: ITaskRiskReason[] = [];
  let score = intentBaseScore(intent);
  if (score > 0) {
    reasons.push({
      code: `intent-${intent.kind}`,
      message: `Intent ${intent.kind} carries baseline risk weight ${score}.`,
      weight: score,
    });
  }

  // Boundary violation reasons
  const boundaryConcerns: string[] = [];
  if (arch.boundaryViolationCounts.error > 0) {
    const w = Math.min(arch.boundaryViolationCounts.error, 5) * 3;
    score += w;
    reasons.push({
      code: 'boundary-violations-error',
      message: `Repository has ${arch.boundaryViolationCounts.error} boundary violation(s) at error severity.`,
      weight: w,
    });
    boundaryConcerns.push(`${arch.boundaryViolationCounts.error} boundary error(s) outstanding.`);
  }
  if (arch.boundaryViolationCounts.warning > 0) {
    score += 1;
    boundaryConcerns.push(`${arch.boundaryViolationCounts.warning} boundary warning(s) outstanding.`);
  }

  // Impact-driven reasons
  const policyConcerns: string[] = [];
  const ownershipGaps: string[] = [];
  const testGaps: string[] = [];
  if (impact) {
    if (impact.directDependents.length > 5) {
      const w = 6;
      score += w;
      reasons.push({
        code: 'many-direct-dependents',
        message: `${impact.directDependents.length} direct dependents.`,
        weight: w,
      });
    }
    if (impact.transitiveDependents.length > 25) {
      const w = 8;
      score += w;
      reasons.push({
        code: 'large-transitive-closure',
        message: `${impact.transitiveDependents.length} transitive dependents.`,
        weight: w,
      });
    }
    if (impact.potentialBoundaryRisks.length > 0) {
      const w = Math.min(impact.potentialBoundaryRisks.length, 3) * 2;
      score += w;
      reasons.push({
        code: 'boundary-rule-impact',
        message: `${impact.potentialBoundaryRisks.length} boundary rule(s) potentially impacted.`,
        weight: w,
      });
      for (const b of impact.potentialBoundaryRisks)
        boundaryConcerns.push(`${b.ruleId} — ${b.reason}`);
    }
    if (impact.affectedPolicies.length > 0) {
      const w = 4;
      score += w;
      reasons.push({
        code: 'policy-impact',
        message: `${impact.affectedPolicies.length} policy concern(s).`,
        weight: w,
      });
      for (const p of impact.affectedPolicies) policyConcerns.push(`${p.policyId} — ${p.reason}`);
    }
    if ((impact.affectedOwnership?.requiredReviewFiles.length ?? 0) > 0) {
      const w = 5;
      score += w;
      reasons.push({
        code: 'ownership-required-review',
        message: `${impact.affectedOwnership?.requiredReviewFiles.length} ownership-protected file(s).`,
        weight: w,
      });
      for (const f of impact.affectedOwnership?.requiredReviewFiles ?? []) ownershipGaps.push(f);
    } else if (files.length > 0 && (impact.affectedOwnership?.matches.length ?? 0) === 0) {
      ownershipGaps.push('No ownership rules match the affected files.');
    }
    if (impact.likelyTests.length === 0 && files.length > 0) {
      const w = 4;
      score += w;
      reasons.push({
        code: 'no-likely-tests',
        message: 'No likely tests detected for the affected files.',
        weight: w,
      });
      testGaps.push('No co-located tests found.');
    }
  }

  // High-impact files within affected set
  const archHigh = summarizeFanFiles(arch.highImpactFiles);
  const highFanInFiles: string[] = [];
  const highFanOutFiles: string[] = [];
  if (files.length > 0) {
    for (const f of files) {
      if (archHigh.highIn.some((hi) => isLikelyTouching(f, hi) || isLikelyTouching(hi, f)))
        highFanInFiles.push(f);
      if (archHigh.highOut.some((ho) => isLikelyTouching(f, ho) || isLikelyTouching(ho, f)))
        highFanOutFiles.push(f);
    }
  }
  // Also surface global high-impact files mentioned in the task text
  for (const hi of archHigh.highIn) {
    if (trimmed.toLowerCase().includes(hi.toLowerCase()) && !highFanInFiles.includes(hi))
      highFanInFiles.push(hi);
  }
  if (highFanInFiles.length > 0) {
    const w = 5;
    score += w;
    reasons.push({
      code: 'high-fan-in-file',
      message: `${highFanInFiles.length} affected file(s) have high fan-in.`,
      weight: w,
    });
  }
  if (highFanOutFiles.length > 0) {
    const w = 3;
    score += w;
    reasons.push({
      code: 'high-fan-out-file',
      message: `${highFanOutFiles.length} affected file(s) have high fan-out.`,
      weight: w,
    });
  }

  // No-tests-in-repo escalation
  if (arch.graphSummary.tests === 0) {
    const w = 3;
    score += w;
    reasons.push({
      code: 'repo-has-no-tests',
      message: 'Repository has no tests; any change is harder to verify.',
      weight: w,
    });
  }

  // Public-API hint
  const publicApiTouch = files.some(
    (f) =>
      f.endsWith('/index.ts') ||
      f.includes('plugin-api/') ||
      f.includes('public-api/'),
  );
  if (publicApiTouch) {
    const w = 6;
    score += w;
    reasons.push({
      code: 'public-api-touch',
      message: 'Affected files include a public API surface.',
      weight: w,
    });
  }

  if (intent.requiredHumanReview) {
    const w = 2;
    score += w;
    reasons.push({
      code: 'intent-requires-review',
      message: 'Intent classifier flagged this task as requiring human review.',
      weight: w,
    });
  }

  const baseScore = score;
  const baseRiskLevel = classifyLevel(baseScore);

  // Memory-weighted risk pass. Memory can only raise risk (never lower).
  let memory: ITaskRiskMemoryReport | undefined;
  const inferredConstructs = inferConstructsFromIntent(intent, inspection);
  if (options.includeMemory) {
    const index = loadRepositoryMemory(inspection.projectRoot);
    memory = buildMemoryReport(index, {
      taskTokens: tokens(trimmed),
      affectedFiles: files,
      affectedConstructs: inferredConstructs,
    });
    if (memory.score > 0) {
      score += memory.score;
      reasons.push({
        code: 'memory-adjustment',
        message: `Memory adjustment +${memory.score}${memory.capped ? ` (capped at ${memory.cap})` : ''}.`,
        weight: memory.score,
      });
    }
  }

  const riskLevel = classifyLevel(score);

  const recommendedReviewCommands = [
    'shrk brief "' + (trimmed || '<task>') + '"',
    'shrk impact --since main --format json',
    'shrk architecture map --risk --signals',
    'shrk policy run --explain-overrides',
  ];
  if (publicApiTouch) recommendedReviewCommands.push('shrk api report --all --public-only');
  if (ownershipGaps.length > 0) recommendedReviewCommands.push('shrk owners impact');
  if (testGaps.length > 0) recommendedReviewCommands.push('shrk tests missing --since main');
  if (memory && memory.score > 0) recommendedReviewCommands.push('shrk memory risk "' + (trimmed || '<task>') + '"');

  const humanApprovalRequired =
    riskLevel === TaskRiskLevel.High ||
    riskLevel === TaskRiskLevel.Critical ||
    intent.requiredHumanReview;

  const out: ITaskRiskReport = {
    schema: TASK_RISK_SCHEMA,
    generatedAt: new Date().toISOString(),
    task: trimmed,
    intent,
    riskLevel,
    score,
    reasons,
    affectedFiles: files,
    affectedConstructs: inferredConstructs,
    highFanInFiles,
    highFanOutFiles,
    ownershipGaps: [...new Set(ownershipGaps)].slice(0, 10),
    testGaps: [...new Set(testGaps)].slice(0, 10),
    boundaryConcerns: [...new Set(boundaryConcerns)].slice(0, 10),
    policyConcerns: [...new Set(policyConcerns)].slice(0, 10),
    recommendedReviewCommands,
    humanApprovalRequired,
    baseScore,
    baseRiskLevel,
    adjustedScore: score,
    adjustedRiskLevel: riskLevel,
  };
  if (memory) out.memory = memory;
  return out;
}

export function renderTaskRiskText(r: ITaskRiskReport): string {
  const lines: string[] = [];
  lines.push('=== Task risk ===');
  lines.push(`  task              ${r.task}`);
  lines.push(`  intent            ${r.intent.kind} (confidence ${r.intent.confidence})`);
  lines.push(`  risk level        ${r.riskLevel}`);
  lines.push(`  score             ${r.score}`);
  if (r.memory) {
    lines.push(`  base score        ${r.baseScore} (${r.baseRiskLevel})`);
    lines.push(`  memory adj        +${r.memory.score}${r.memory.capped ? ` (capped at ${r.memory.cap})` : ''}${r.memory.missing ? ' — index missing' : ''}${r.memory.stale ? ' — index stale' : ''}`);
  }
  lines.push(`  human approval    ${r.humanApprovalRequired ? 'yes' : 'no'}`);
  if (r.affectedFiles.length > 0) {
    lines.push('Affected files:');
    for (const f of r.affectedFiles.slice(0, 10)) lines.push(`  • ${f}`);
  }
  if (r.highFanInFiles.length > 0) lines.push('High fan-in: ' + r.highFanInFiles.join(', '));
  if (r.highFanOutFiles.length > 0) lines.push('High fan-out: ' + r.highFanOutFiles.join(', '));
  if (r.boundaryConcerns.length > 0) {
    lines.push('Boundary concerns:');
    for (const b of r.boundaryConcerns) lines.push(`  • ${b}`);
  }
  if (r.policyConcerns.length > 0) {
    lines.push('Policy concerns:');
    for (const p of r.policyConcerns) lines.push(`  • ${p}`);
  }
  if (r.ownershipGaps.length > 0) {
    lines.push('Ownership gaps:');
    for (const o of r.ownershipGaps) lines.push(`  • ${o}`);
  }
  if (r.testGaps.length > 0) {
    lines.push('Test gaps:');
    for (const t of r.testGaps) lines.push(`  • ${t}`);
  }
  lines.push('Reasons:');
  for (const reason of r.reasons) lines.push(`  • [${reason.code}] ${reason.message} (+${reason.weight})`);
  lines.push('Recommended review:');
  for (const c of r.recommendedReviewCommands) lines.push(`  $ ${c}`);
  return lines.join('\n') + '\n';
}

export function renderTaskRiskMarkdown(r: ITaskRiskReport): string {
  const lines: string[] = [];
  lines.push(`# Task risk — ${r.task || '(empty)'}`);
  lines.push('');
  lines.push(`- intent: **${r.intent.kind}** (confidence ${r.intent.confidence})`);
  lines.push(`- risk: **${r.riskLevel}** (score ${r.score})`);
  if (r.memory) {
    lines.push(`- base: **${r.baseRiskLevel}** (score ${r.baseScore})`);
    lines.push(`- memory adjustment: **+${r.memory.score}**${r.memory.capped ? ` _(capped at ${r.memory.cap})_` : ''}${r.memory.missing ? ' _(index missing)_' : ''}${r.memory.stale ? ' _(index stale)_' : ''}`);
  }
  lines.push(`- human approval: ${r.humanApprovalRequired ? '**yes**' : 'no'}`);
  lines.push('');
  if (r.memory && r.memory.signals.length > 0) {
    lines.push('## Memory signals');
    for (const s of r.memory.signals.slice(0, 12)) lines.push(`- [${s.source}] ${s.message} (+${s.weight})`);
    lines.push('');
  }
  if (r.affectedFiles.length > 0) {
    lines.push('## Affected files');
    for (const f of r.affectedFiles) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (r.boundaryConcerns.length > 0) {
    lines.push('## Boundary concerns');
    for (const b of r.boundaryConcerns) lines.push(`- ${b}`);
    lines.push('');
  }
  if (r.policyConcerns.length > 0) {
    lines.push('## Policy concerns');
    for (const p of r.policyConcerns) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('## Reasons');
  for (const reason of r.reasons) lines.push(`- **${reason.code}** (+${reason.weight}) — ${reason.message}`);
  lines.push('');
  lines.push('## Recommended review');
  for (const c of r.recommendedReviewCommands) lines.push(`- \`${c}\``);
  return lines.join('\n') + '\n';
}

export function summarizeTaskRisk(r: ITaskRiskReport): string {
  return `task-risk=${r.riskLevel} score=${r.score} reasons=${r.reasons.length}`;
}

// Internal helper used by tests
export function _classifyLevel(score: number): TaskRiskLevel {
  return classifyLevel(score);
}

// Used to silence unused-import lint when nothing else uses statSync
void statSync;
