/**
 * Agent handoff packet.
 *
 * `brief` is the *pre-work* context for an agent. `handoff` is the
 * *continue-from-here* context: it captures current task status, what was
 * already done, what remains, and the single next safe command — so a
 * different agent (or the same agent after a context reset) can pick up
 * without redoing discovery.
 *
 * Read-only. Sources state from:
 *  - a passed-in task string + inspection
 *  - an existing dev session (sessionId)
 *  - an existing feature bundle (bundleId)
 *  - optionally a git ref (`since`) for changed-files surfacing
 *
 * Never writes (the CLI write step is the caller's responsibility).
 */

import * as nodePath from 'node:path';
import { readFeatureBundle, type IFeatureBundle } from './feature-bundle.ts';
import { scanDevSession, DevSessionPlanStatus, type IDevSessionLoad, type IDevSessionState } from './dev-session.ts';
import { buildAgentBrief, BriefMode, type IAgentBrief } from './agent-brief.ts';
import { getChangedFiles } from './git-helpers.ts';
import { buildTaskRiskReport, type ITaskRiskReport } from './task-risk.ts';
import { buildAgentContract, type IAgentContract } from './agent-contract.ts';
import { buildTaskExecutionGraph, type ITaskExecutionGraph } from './execution-graph.ts';
import { simulatePlan, type IPlanSimulationReport } from './plan-simulation.ts';
import { loadRepositoryMemory, memoryRiskForTask, type IMemoryRiskReport } from './repo-memory.ts';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_HANDOFF_SCHEMA = 'sharkcraft.agent-handoff/v1';

export interface IAgentHandoffInput {
  task?: string;
  /** Existing dev session to continue. */
  sessionId?: string;
  /** Existing feature bundle to continue. */
  bundleId?: string;
  /** Git ref to surface "since this point" changed files. */
  since?: string;
  /** Generate chunked output. */
  chunked?: boolean;
  /** Output destination filename (chunks live in the same dir if chunked). */
  output?: string;
  /** Fold an agent contract summary into the handoff. */
  includeContract?: boolean;
  /** Include the same pre-work brief content (matches `shrk brief`). */
  includeBrief?: boolean;
  /** Include a summary of the task execution graph. */
  includeExecutionGraph?: boolean;
  /** Include memory-driven warnings. */
  includeMemory?: boolean;
  /** Include plan simulation summary when a plan path is supplied. */
  includePlanSimulation?: string;
  /** Role for contract/handoff personalisation. */
  role?: string;
  /** Mode for contract personalisation. */
  mode?: string;
}

export interface IAgentHandoffChunk {
  file: string;
  sectionId: string;
  title: string;
  body: string;
  tokenEstimate: number;
}

export interface IAgentHandoffReport {
  schema: typeof AGENT_HANDOFF_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  task: string;
  knownContext: readonly string[];
  doNotTouch: readonly string[];
  relevantFiles: readonly string[];
  relevantRules: readonly string[];
  currentStatus: string;
  nextSafeCommand: string;
  validationExpectations: readonly string[];
  humanApprovalPoints: readonly string[];
  availableArtifacts: readonly { kind: string; path: string }[];
  safetyNote: string;
  markdown: string;
  chunks?: readonly IAgentHandoffChunk[];
  /** Per-task risk summary (best-effort; only when a task is provided). */
  taskRiskSummary?: { level: string; score: number; reasons: readonly string[] };
  /** Full task-risk report (when --include-memory/--include-contract drove memory-weighted risk). */
  taskRisk?: ITaskRiskReport;
  /** Full agent contract when --include-contract was set. */
  contract?: IAgentContract;
  /** Short contract summary text. */
  contractSummary?: {
    role: string;
    mode: string;
    forbiddenCommands: readonly string[];
    requiredValidations: readonly string[];
    requiredReviews: readonly string[];
    humanApprovalGates: readonly string[];
    recommendedNextCommand: string;
    contractHash: string;
  };
  /** Execution graph (full) when --include-execution-graph. */
  executionGraph?: ITaskExecutionGraph;
  /** Short execution graph summary. */
  executionGraphSummary?: { nodes: number; edges: number; humanApprovalNodes: readonly string[] };
  /** Plan simulation when --include-plan-simulation <plan.json>. */
  planSimulation?: IPlanSimulationReport;
  /** Memory-derived risk (when --include-memory and an index exists). */
  memoryRisk?: IMemoryRiskReport;
  source: {
    kind: 'task-only' | 'session' | 'bundle' | 'session+bundle';
    sessionId?: string;
    bundleId?: string;
  };
  /** Uncertainty report (confidence + signals + safe fallback). */
  uncertainty?: IUncertaintyReport;
}

function tokensEstimate(s: string): number {
  // SharkCraft convention: ~4 chars per token, with a floor of 1.
  return Math.max(1, Math.ceil(s.length / 4));
}

function formatList(items: readonly string[], bullet = '-'): string {
  if (items.length === 0) return '(none)';
  return items.map((i) => `${bullet} ${i}`).join('\n');
}

function buildSafetyNote(): string {
  return [
    'Before any write step:',
    '  - Generation: `shrk gen --dry-run --save-plan /tmp/plan.json`, then `shrk plan review`,',
    '    then `shrk apply --verify-signature`.',
    '  - MCP tools never write to disk. The CLI is the only write path.',
    '  - Pack-contributed verification commands are NOT auto-run.',
  ].join('\n');
}

function describeSession(load: IDevSessionLoad): {
  status: string;
  next: string;
  artifacts: { kind: string; path: string }[];
  approvals: string[];
} {
  const state = load.state;
  const artifacts: { kind: string; path: string }[] = [];
  const approvals: string[] = [];
  if (!state) {
    return { status: 'legacy', next: `shrk dev status ${load.id}`, artifacts, approvals };
  }
  if (state.briefFile) artifacts.push({ kind: 'brief', path: state.briefFile });
  for (const a of state.appliedPlans ?? []) {
    artifacts.push({ kind: 'applied-plan', path: a.file });
  }
  for (const v of state.validations ?? []) {
    artifacts.push({ kind: 'validation', path: v.startedAt });
  }
  const next = state.nextAction ? state.nextAction : `shrk dev status ${state.id}`;
  for (const p of state.plans ?? []) {
    if (p.status === DevSessionPlanStatus.Saved || p.status === DevSessionPlanStatus.Reviewed) {
      approvals.push(`Review + apply plan "${p.file}".`);
    }
  }
  return { status: state.phase, next, artifacts, approvals };
}

function describeBundle(bundle: IFeatureBundle): {
  status: string;
  next: string;
  artifacts: { kind: string; path: string }[];
  approvals: string[];
} {
  const artifacts: { kind: string; path: string }[] = [];
  for (const plan of bundle.plans ?? []) {
    if (plan.file) artifacts.push({ kind: 'plan', path: plan.file });
  }
  for (const v of bundle.validations ?? []) {
    artifacts.push({ kind: 'validation', path: v.startedAt });
  }
  const next = bundle.nextAction ?? 'shrk bundle show ' + bundle.id;
  const approvals: string[] = [];
  for (const plan of bundle.plans ?? []) {
    if (plan.status === 'saved' || plan.status === 'reviewed' || plan.status === 'intent') {
      approvals.push(`Apply plan "${plan.name}" (${plan.file}).`);
    }
  }
  return { status: bundle.status as string, next, artifacts, approvals };
}

function chunkBody(
  sectionId: string,
  title: string,
  body: string,
  order: number,
): IAgentHandoffChunk {
  const file = `${String(order).padStart(2, '0')}-${sectionId}.md`;
  return {
    file,
    sectionId,
    title,
    body,
    tokenEstimate: tokensEstimate(body),
  };
}

export async function buildAgentHandoff(
  inspection: ISharkcraftInspection,
  input: IAgentHandoffInput,
): Promise<IAgentHandoffReport> {
  const projectRoot = inspection.projectRoot;
  let session: IDevSessionLoad | null = null;
  if (input.sessionId) {
    session = scanDevSession(projectRoot, input.sessionId);
  }
  let bundle: IFeatureBundle | null = null;
  if (input.bundleId) {
    bundle = readFeatureBundle(projectRoot, input.bundleId);
  }
  const sessionState: IDevSessionState | null = session?.state ?? null;
  const task = input.task ?? sessionState?.task ?? bundle?.task ?? '(no task supplied)';
  const knownContext: string[] = [];
  const doNotTouch: string[] = [
    'Do not bypass `shrk apply --verify-signature`.',
    'Do not commit changes inside `node_modules/`, `dist/`, or `.sharkcraft/cache/`.',
    'Do not modify generated bundle JSON by hand — re-run the generator instead.',
  ];
  const relevantRules: string[] = [];
  const relevantFiles: string[] = [];
  let status = 'pending';
  let next = 'shrk doctor';
  let approvals: string[] = [];
  const artifacts: { kind: string; path: string }[] = [];
  if (session) {
    const d = describeSession(session);
    const sessionId = sessionState?.id ?? session.id;
    status = `session ${sessionId} in phase ${d.status}`;
    next = d.next;
    approvals.push(...d.approvals);
    artifacts.push(...d.artifacts);
    knownContext.push(`Active dev session: ${sessionId}`);
    if (sessionState?.briefFile) {
      knownContext.push(`Brief file: ${sessionState.briefFile}`);
      relevantFiles.push(sessionState.briefFile);
    }
    for (const plan of sessionState?.plans ?? []) {
      relevantFiles.push(plan.file);
    }
  }
  if (bundle) {
    const d = describeBundle(bundle);
    status = session ? `${status}; bundle ${bundle.id} (${d.status})` : `bundle ${bundle.id} (${d.status})`;
    next = next === 'shrk doctor' ? d.next : next;
    approvals.push(...d.approvals);
    artifacts.push(...d.artifacts);
    knownContext.push(`Active feature bundle: ${bundle.id} (${bundle.status})`);
    for (const file of bundle.affectedFiles ?? []) relevantFiles.push(file);
  }
  if (input.since) {
    const changed = getChangedFiles(projectRoot, { since: input.since });
    if (changed.length > 0) {
      knownContext.push(`${changed.length} changed file(s) since ${input.since}`);
      for (const f of changed) relevantFiles.push(f);
    }
  }
  // Pull the most relevant top-priority rules from the inspection so the
  // handoff carries enough behavioural context.
  for (const r of inspection.knowledgeEntries.slice(0, 10)) {
    relevantRules.push(`${r.id}: ${r.title}`);
  }
  // Render a brief alongside for the chunked path so the agent has the same
  // pre-work context as a fresh `shrk brief`.
  let brief: IAgentBrief | null = null;
  if (input.chunked) {
    brief = await buildAgentBrief(inspection, {
      ...(task !== '(no task supplied)' ? { task } : {}),
      mode: BriefMode.Handoff,
      files: [...new Set(relevantFiles)],
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
      chunked: true,
    });
  }
  const validationExpectations: string[] = [
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
    'shrk doctor',
    'shrk check boundaries',
  ];
  const humanApprovalPoints: string[] = approvals.length > 0 ? approvals : [
    'After plan generation, a human must run `shrk plan review` and `shrk apply --verify-signature`.',
  ];
  const safetyNote = buildSafetyNote();
  const sourceKind: IAgentHandoffReport['source']['kind'] =
    session && bundle ? 'session+bundle' : session ? 'session' : bundle ? 'bundle' : 'task-only';
  // Compose the markdown body.
  const lines: string[] = [];
  lines.push(`# Agent handoff — ${task}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Project: ${projectRoot}`);
  lines.push(`Source: ${sourceKind}`);
  lines.push('');
  lines.push('## Known context');
  lines.push('');
  lines.push(formatList(knownContext));
  lines.push('');
  lines.push('## Do NOT touch');
  lines.push('');
  lines.push(formatList(doNotTouch));
  lines.push('');
  lines.push('## Current status');
  lines.push('');
  lines.push(status);
  lines.push('');
  lines.push('## Next safe command');
  lines.push('');
  lines.push('```');
  lines.push(next);
  lines.push('```');
  lines.push('');
  lines.push('## Validation expectations');
  lines.push('');
  lines.push(formatList(validationExpectations));
  lines.push('');
  lines.push('## Human approval points');
  lines.push('');
  lines.push(formatList(humanApprovalPoints));
  lines.push('');
  lines.push('## Relevant files');
  lines.push('');
  lines.push(formatList(relevantFiles));
  lines.push('');
  lines.push('## Relevant rules');
  lines.push('');
  lines.push(formatList(relevantRules));
  lines.push('');
  lines.push('## Available artifacts');
  lines.push('');
  if (artifacts.length === 0) lines.push('(none)');
  else for (const a of artifacts) lines.push(`- [${a.kind}] ${a.path}`);
  lines.push('');
  lines.push('## Safety note');
  lines.push('');
  lines.push(safetyNote);
  if (brief) {
    lines.push('');
    lines.push('## Pre-work brief (reference)');
    lines.push('');
    lines.push(brief.markdown);
  }
  const markdown = lines.join('\n');
  const chunks: IAgentHandoffChunk[] = [];
  if (input.chunked) {
    chunks.push(chunkBody('00-overview', 'Overview', `# ${task}\n\nSource: ${sourceKind}\nStatus: ${status}\n`, 0));
    chunks.push(chunkBody('next-command', 'Next safe command', `\`\`\`\n${next}\n\`\`\``, 1));
    chunks.push(chunkBody('known-context', 'Known context', formatList(knownContext), 2));
    chunks.push(chunkBody('do-not-touch', 'Do not touch', formatList(doNotTouch), 3));
    chunks.push(chunkBody('validation', 'Validation expectations', formatList(validationExpectations), 4));
    chunks.push(chunkBody('approvals', 'Human approval points', formatList(humanApprovalPoints), 5));
    chunks.push(chunkBody('relevant-files', 'Relevant files', formatList(relevantFiles), 6));
    chunks.push(chunkBody('relevant-rules', 'Relevant rules', formatList(relevantRules), 7));
    chunks.push(chunkBody('safety', 'Safety note', safetyNote, 8));
    if (brief) {
      chunks.push(chunkBody('brief', 'Pre-work brief', brief.markdown, 9));
    }
  }
  // Attach a task-risk summary if a task is provided. Best-effort.
  let taskRiskSummary: { level: string; score: number; reasons: readonly string[] } | undefined;
  let taskRiskFull: ITaskRiskReport | undefined;
  if (input.task && input.task.trim().length > 0) {
    try {
      const r = await buildTaskRiskReport(input.task, inspection, {
        ...(input.since ? { since: input.since } : {}),
        ...(input.includeMemory ? { includeMemory: true } : {}),
      });
      taskRiskFull = r;
      taskRiskSummary = {
        level: r.riskLevel,
        score: r.score,
        reasons: r.reasons.slice(0, 5).map((reason) => `[${reason.code}] ${reason.message}`),
      };
    } catch {
      /* best-effort */
    }
  }

  // Contract, execution graph, plan simulation, memory.
  let contract: IAgentContract | undefined;
  let contractSummary: IAgentHandoffReport['contractSummary'];
  if (input.includeContract && input.task && input.task.trim().length > 0) {
    try {
      contract = await buildAgentContract(input.task, inspection, {
        ...(input.role ? { role: input.role } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.since ? { since: input.since } : {}),
      });
      const { computeContractHash } = await import('./agent-contract-gate.ts');
      contractSummary = {
        role: contract.role,
        mode: contract.mode,
        forbiddenCommands: contract.forbiddenCommands.slice(0, 6),
        requiredValidations: contract.requiredValidations,
        requiredReviews: contract.requiredReviews,
        humanApprovalGates: contract.humanApprovalGates,
        recommendedNextCommand: contract.recommendedNextCommand,
        contractHash: computeContractHash(contract),
      };
    } catch {
      /* best-effort */
    }
  }
  let executionGraph: ITaskExecutionGraph | undefined;
  let executionGraphSummary: IAgentHandoffReport['executionGraphSummary'];
  if (input.includeExecutionGraph && input.task && input.task.trim().length > 0) {
    try {
      executionGraph = await buildTaskExecutionGraph(input.task, inspection, {
        ...(input.role ? { role: input.role } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.since ? { since: input.since } : {}),
      });
      const approvalNodes = executionGraph.nodes
        .filter((n) => n.kind === 'human-approval')
        .map((n) => n.label);
      executionGraphSummary = {
        nodes: executionGraph.nodes.length,
        edges: executionGraph.edges.length,
        humanApprovalNodes: approvalNodes,
      };
    } catch {
      /* best-effort */
    }
  }
  let planSimulation: IPlanSimulationReport | undefined;
  if (input.includePlanSimulation) {
    try {
      const planPath = input.includePlanSimulation;
      const absPlan = nodePath.isAbsolute(planPath)
        ? planPath
        : nodePath.resolve(projectRoot, planPath);
      planSimulation = await simulatePlan(inspection, absPlan, {
        includeBoundaries: true,
        includeImpact: true,
        includeOwnership: true,
      });
    } catch {
      /* best-effort */
    }
  }
  let memoryRisk: IMemoryRiskReport | undefined;
  if (input.includeMemory && input.task && input.task.trim().length > 0) {
    try {
      const idx = loadRepositoryMemory(projectRoot);
      memoryRisk = memoryRiskForTask(idx, input.task);
    } catch {
      /* best-effort */
    }
  }

  // Extend the markdown body with the included summaries.
  let unifiedMarkdown = markdown;
  if (contractSummary) {
    unifiedMarkdown += '\n\n## Agent contract\n\n';
    unifiedMarkdown += `- role: ${contractSummary.role}\n- mode: ${contractSummary.mode}\n- hash: \`${contractSummary.contractHash.slice(0, 16)}…\`\n`;
    if (contractSummary.humanApprovalGates.length > 0) {
      unifiedMarkdown += '\n### Human approval gates\n\n' + formatList(contractSummary.humanApprovalGates) + '\n';
    }
    if (contractSummary.forbiddenCommands.length > 0) {
      unifiedMarkdown += '\n### Forbidden commands\n\n' + formatList(contractSummary.forbiddenCommands) + '\n';
    }
    if (contractSummary.requiredValidations.length > 0) {
      unifiedMarkdown += '\n### Required validations\n\n' + formatList(contractSummary.requiredValidations) + '\n';
    }
    unifiedMarkdown += `\nRecommended next command: \`${contractSummary.recommendedNextCommand}\`\n`;
  }
  if (memoryRisk) {
    unifiedMarkdown += '\n\n## Memory-driven warnings\n\n';
    unifiedMarkdown += `- overlap: **${memoryRisk.recommendation}**\n`;
    if (memoryRisk.matchedFiles.length > 0) {
      unifiedMarkdown += `- top risky files:\n`;
      for (const f of memoryRisk.matchedFiles.slice(0, 8))
        unifiedMarkdown += `  - ${f.path} (touches=${f.touchCount}, conflicts=${f.conflictCount})\n`;
    }
  }
  if (executionGraphSummary) {
    unifiedMarkdown += '\n\n## Execution graph\n\n';
    unifiedMarkdown += `- nodes: ${executionGraphSummary.nodes}\n- edges: ${executionGraphSummary.edges}\n`;
    if (executionGraphSummary.humanApprovalNodes.length > 0) {
      unifiedMarkdown += `- human approval: ${executionGraphSummary.humanApprovalNodes.join(' | ')}\n`;
    }
  }
  if (planSimulation) {
    unifiedMarkdown += '\n\n## Plan simulation\n\n';
    unifiedMarkdown += `- source: \`${planSimulation.source}\`\n- readiness: **${planSimulation.applyReadiness}**\n- public API touched: ${planSimulation.publicApiTouched ? 'yes' : 'no'}\n- ownership review required: ${planSimulation.ownershipReviewRequired ? 'yes' : 'no'}\n`;
  }

  return {
    schema: AGENT_HANDOFF_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    task,
    knownContext,
    doNotTouch,
    relevantFiles,
    relevantRules,
    currentStatus: status,
    nextSafeCommand: next,
    validationExpectations,
    humanApprovalPoints,
    availableArtifacts: artifacts,
    safetyNote,
    markdown: unifiedMarkdown,
    ...(taskRiskFull ? { taskRisk: taskRiskFull } : {}),
    ...(contract ? { contract } : {}),
    ...(contractSummary ? { contractSummary } : {}),
    ...(executionGraph ? { executionGraph } : {}),
    ...(executionGraphSummary ? { executionGraphSummary } : {}),
    ...(planSimulation ? { planSimulation } : {}),
    ...(memoryRisk ? { memoryRisk } : {}),
    ...(chunks.length > 0 ? { chunks } : {}),
    ...(taskRiskSummary ? { taskRiskSummary } : {}),
    source: {
      kind: sourceKind,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    },
    uncertainty: buildHandoffUncertainty({
      taskRiskSummary,
      relevantFiles,
      knownContext,
      sourceKind,
    }),
  };
}

function buildHandoffUncertainty(input: {
  taskRiskSummary?: { level: string; score: number; reasons: readonly string[] };
  relevantFiles: readonly string[];
  knownContext: readonly string[];
  sourceKind: string;
}): IUncertaintyReport {
  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'medium';
  const reasons: string[] = [];
  const missing: { id: string; message: string }[] = [];
  if (input.sourceKind === 'task-only') {
    confidence = 'low';
    reasons.push('Handoff derived from task only — no session or bundle context.');
    missing.push({ id: 'no-session', message: 'No session context attached.' });
    missing.push({ id: 'no-bundle', message: 'No bundle context attached.' });
  }
  if (input.taskRiskSummary && input.taskRiskSummary.level === 'high') {
    confidence = 'low';
    reasons.push(`Task risk is HIGH (score ${input.taskRiskSummary.score}).`);
  }
  if (input.relevantFiles.length === 0) {
    missing.push({ id: 'no-relevant-files', message: 'No relevant files identified.' });
    if (confidence !== 'low') confidence = 'medium';
  }
  if (input.knownContext.length === 0) {
    missing.push({ id: 'no-known-context', message: 'No known context paragraphs.' });
  }
  return buildUncertaintyReport({
    confidence,
    reasons,
    missingSignals: missing,
    suggestedCommands: [
      'shrk task "<task>" --commands-first',
      'shrk dev status',
    ],
    safeFallbackCommand: 'shrk start-here',
  });
}

export function defaultHandoffOutputPath(projectRoot: string, task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return nodePath.join(projectRoot, '.sharkcraft', 'handoffs', `${Date.now()}-${slug || 'handoff'}.md`);
}
