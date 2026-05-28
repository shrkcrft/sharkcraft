import {
  lintPipelines,
  type IPipelineLintIssue,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import type { IAiBlock } from '@shrkcrft/ai';

export type PipelineAuditFindingSeverity = 'info' | 'warn' | 'error';

export interface IPipelineAuditFinding {
  severity: PipelineAuditFindingSeverity;
  category: string;
  stepId?: string;
  message: string;
  sources: readonly string[];
}

export interface ILlmPipelineAuditFinding {
  severity: PipelineAuditFindingSeverity;
  category: string;
  message: string;
  confidence: number;
}

export type PipelineAuditVerdict = 'ok' | 'minor' | 'stale' | 'broken';

export interface IPipelineAuditEntry {
  pipelineId: string;
  verdict: PipelineAuditVerdict;
  deterministicFindings: readonly IPipelineAuditFinding[];
  llmFindings: readonly ILlmPipelineAuditFinding[];
}

export interface IPipelineAuditReport {
  auditId: string;
  generatedAt: string;
  llmEnriched: boolean;
  llmProviderId: string | null;
  pipelines: readonly IPipelineAuditEntry[];
  summary: { ok: number; minor: number; stale: number; broken: number; total: number };
  ai?: IAiBlock;
}

export interface IBuildPipelineAuditOptions {
  pipelineId?: string;
}

export function buildPipelineAudit(
  inspection: ISharkcraftInspection,
  options: IBuildPipelineAuditOptions = {},
): IPipelineAuditReport {
  const targetIds = options.pipelineId ? [options.pipelineId] : undefined;
  const lint = lintPipelines(inspection, targetIds);

  const byPipeline = new Map<string, IPipelineLintIssue[]>();
  for (const r of lint.results) byPipeline.set(r.pipelineId, [...r.issues]);

  const pipelines: IPipelineAuditEntry[] = [];
  for (const [pipelineId, issues] of byPipeline.entries()) {
    const det: IPipelineAuditFinding[] = issues.map((i) => ({
      severity: normaliseSeverity(i.severity),
      category: i.code,
      ...(i.stepId ? { stepId: i.stepId } : {}),
      message: i.message,
      sources: ['pipelines lint'],
    }));
    pipelines.push({
      pipelineId,
      verdict: deriveVerdict(det),
      deterministicFindings: det,
      llmFindings: [],
    });
  }

  const summary = pipelines.reduce(
    (acc, p) => {
      acc[p.verdict] += 1;
      acc.total += 1;
      return acc;
    },
    { ok: 0, minor: 0, stale: 0, broken: 0, total: 0 },
  );

  const generatedAt = new Date().toISOString();
  return {
    auditId: `audit-${generatedAt.replace(/[:.]/g, '-')}`,
    generatedAt,
    llmEnriched: false,
    llmProviderId: null,
    pipelines,
    summary,
  };
}

export interface IPipelineFixInstruction {
  pipelineId: string;
  stepId?: string;
  findingCategory: string;
  finding: string;
  severity: PipelineAuditFindingSeverity;
  intent: string;
  agentPrompt: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'deterministic' | 'llm';
  llmSuggestion?: string;
}

export interface IPipelineFixPlan {
  fixPlanId: string;
  generatedAt: string;
  auditId: string;
  sourceHint: string;
  fixes: readonly IPipelineFixInstruction[];
  summary: {
    fixCount: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
  };
}

const SOURCE_HINT =
  'Edit pipelines via the files registered in `sharkcraft/sharkcraft.config.ts` (pipelineFiles). Locate the pipeline literal by its `id`.';

export function buildPipelineFixPlan(report: IPipelineAuditReport): IPipelineFixPlan {
  const fixes: IPipelineFixInstruction[] = [];
  for (const p of report.pipelines) {
    for (const f of p.deterministicFindings) {
      fixes.push(dispatchDeterministic(p.pipelineId, f));
    }
    for (const f of p.llmFindings) {
      fixes.push(makeLlmFix(p.pipelineId, f));
    }
  }
  const summary = {
    fixCount: fixes.length,
    highConfidence: fixes.filter((f) => f.confidence === 'high').length,
    mediumConfidence: fixes.filter((f) => f.confidence === 'medium').length,
    lowConfidence: fixes.filter((f) => f.confidence === 'low').length,
  };
  const generatedAt = new Date().toISOString();
  return {
    fixPlanId: `fix-${generatedAt.replace(/[:.]/g, '-')}`,
    generatedAt,
    auditId: report.auditId,
    sourceHint: SOURCE_HINT,
    fixes,
    summary,
  };
}

function normaliseSeverity(s: 'error' | 'warning' | 'info'): PipelineAuditFindingSeverity {
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warn';
  return 'info';
}

function deriveVerdict(findings: readonly IPipelineAuditFinding[]): PipelineAuditVerdict {
  if (findings.some((f) => f.severity === 'error')) return 'broken';
  if (findings.some((f) => f.severity === 'warn')) return 'stale';
  if (findings.some((f) => f.severity === 'info')) return 'minor';
  return 'ok';
}

function dispatchDeterministic(
  pipelineId: string,
  f: IPipelineAuditFinding,
): IPipelineFixInstruction {
  const confidenceMap: Record<string, 'high' | 'medium' | 'low'> = {
    'missing-title': 'high',
    'missing-step-id': 'high',
    'missing-step-type': 'high',
    'write-without-review': 'medium',
    'review-points-missing': 'medium',
    'unresolved-reference': 'medium',
    'uncataloged-command': 'low',
  };
  const confidence = confidenceMap[f.category] ?? 'low';
  const stepClause = f.stepId ? ` (step "${f.stepId}")` : '';
  return {
    pipelineId,
    ...(f.stepId ? { stepId: f.stepId } : {}),
    findingCategory: f.category,
    finding: f.message,
    severity: f.severity,
    intent: intentFor(f.category, stepClause),
    agentPrompt: [
      `Locate pipeline "${pipelineId}" (${SOURCE_HINT}).`,
      `Finding: ${f.message}`,
      promptFor(f.category, stepClause, pipelineId),
      'Verify the file still parses.',
    ].join('\n'),
    confidence,
    source: 'deterministic',
  };
}

function intentFor(category: string, stepClause: string): string {
  switch (category) {
    case 'missing-title':
      return 'Add a title (and/or description) to the pipeline.';
    case 'missing-step-id':
      return `Add an \`id\` to the unnamed step${stepClause}.`;
    case 'missing-step-type':
      return `Add a \`type\` to the step${stepClause}.`;
    case 'write-without-review':
      return `Mark the writing step${stepClause} with \`humanReview: true\`.`;
    case 'review-points-missing':
      return 'Add at least one explicit `humanReview` checkpoint to this pipeline.';
    case 'unresolved-reference':
      return `Repair an unresolved \`references[]\` id${stepClause}.`;
    case 'uncataloged-command':
      return `Either align the cliCommand to a cataloged \`shrk\` verb${stepClause} or document the new command.`;
    default:
      return `Address finding "${category}"${stepClause}.`;
  }
}

function promptFor(category: string, stepClause: string, pipelineId: string): string {
  switch (category) {
    case 'missing-title':
      return 'Add a `title: "<short name>"` field at the pipeline level. Optional `description` for one-paragraph context.';
    case 'missing-step-id':
      return `Each step must have a unique kebab-case \`id\` within pipeline "${pipelineId}". Pick a name that summarises the step's intent.`;
    case 'missing-step-type':
      return `The step${stepClause} must have a \`type\` (e.g. shell-command, generation-plan, apply-plan).`;
    case 'write-without-review':
      return `Writing steps must declare \`humanReview: true\` so the agent pauses for confirmation.`;
    case 'review-points-missing':
      return 'A pipeline that mutates files must include at least one human-review checkpoint.';
    case 'unresolved-reference':
      return 'The id in `references[]` does not match any template or rule. Either remove it or correct the spelling.';
    case 'uncataloged-command':
      return 'Either replace the command with a known `shrk` verb or extend the catalog if this is a legitimate new command.';
    default:
      return 'Apply a minimal change that resolves the finding without touching unrelated fields.';
  }
}

function makeLlmFix(pipelineId: string, f: ILlmPipelineAuditFinding): IPipelineFixInstruction {
  return {
    pipelineId,
    findingCategory: f.category,
    finding: f.message,
    severity: f.severity,
    intent: `Review the LLM-flagged "${f.category}" finding and decide whether to act.`,
    agentPrompt: [
      `Locate pipeline "${pipelineId}" (${SOURCE_HINT}).`,
      `An LLM critique flagged (confidence ${f.confidence.toFixed(2)}): ${f.message}`,
      'LLM findings are advisory — verify against the pipeline body and peers before acting.',
    ].join('\n'),
    confidence: 'low',
    source: 'llm',
  };
}
