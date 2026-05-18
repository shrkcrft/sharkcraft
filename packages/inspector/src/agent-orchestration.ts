/**
 * Agent orchestration planner.
 *
 * Given a task, produce a safe, read-only plan describing how an
 * agent/human should proceed: phases, commands to suggest, MCP tools,
 * expected artifacts, human-approval points, stop conditions.
 *
 * This is not execution. It does not apply, it does not write source.
 *
 * Modes:
 * - conservative: more review/checkpoints; only drafts/plans suggested
 * - balanced: dev session + plan review + apply hint
 * - aggressive: still no auto-apply, but suggests bundle/dev flow faster
 */
import { classifyChangeIntent, ChangeIntentKind, type IChangeIntent } from './change-intent.ts';
import { computeRiskSignals, RiskLevel, type IRiskSignals } from './risk-signals.ts';
import { buildTaskRiskReport, TaskRiskLevel, type ITaskRiskReport } from './task-risk.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_ORCHESTRATION_SCHEMA = 'sharkcraft.agent-orchestration/v1';

export enum OrchestrationMode {
  Conservative = 'conservative',
  Balanced = 'balanced',
  Aggressive = 'aggressive',
}

export interface IOrchestrationPhase {
  id: string;
  title: string;
  purpose: string;
  recommendedCommands: readonly string[];
  mcpTools: readonly string[];
  expectedArtifacts: readonly string[];
  humanApprovalRequired: boolean;
  stopConditions: readonly string[];
  safetyNotes: readonly string[];
}

export interface IAgentOrchestrationPlan {
  schema: typeof AGENT_ORCHESTRATION_SCHEMA;
  generatedAt: string;
  task: string;
  intent: IChangeIntent;
  mode: OrchestrationMode;
  phases: readonly IOrchestrationPhase[];
  firstCommand: string;
  forbiddenActions: readonly string[];
  validationCommands: readonly string[];
  reviewCheckpoints: readonly string[];
  risk?: IRiskSignals;
  taskRisk?: ITaskRiskReport;
  riskAware: boolean;
}

export interface IOrchestrationOptions {
  mode?: OrchestrationMode;
  bundle?: boolean;
  session?: boolean;
  /** When true, fold risk signals into the plan (extra phases / approvals when risk is high). */
  riskAware?: boolean;
}

const FORBIDDEN_ACTIONS: readonly string[] = Object.freeze([
  'Do not run shrk apply without --verify-signature on signed plans.',
  'Do not auto-execute pack-contributed verification commands without local opt-in.',
  'Do not call MCP write tools — MCP is read-only.',
  'Do not publish, tag, or push without explicit human approval.',
]);

function discoveryPhase(intent: IChangeIntent, mode: OrchestrationMode): IOrchestrationPhase {
  return {
    id: 'discovery',
    title: 'Discovery',
    purpose: 'Ground in repository context — rules, paths, templates, constructs relevant to the task.',
    recommendedCommands: [
      'shrk doctor',
      `shrk context --task "${intent.task}"`,
      `shrk brief "${intent.task}"`,
    ],
    mcpTools: ['inspect_workspace', 'get_relevant_context', 'list_templates', 'classify_change_intent'],
    expectedArtifacts: ['brief markdown'],
    humanApprovalRequired: false,
    stopConditions: ['Doctor reports error.', 'Context is empty for this task.'],
    safetyNotes:
      mode === OrchestrationMode.Conservative
        ? ['Read intent + brief carefully before touching any file.']
        : [],
  };
}

function planPhase(intent: IChangeIntent, mode: OrchestrationMode): IOrchestrationPhase {
  const cmds =
    mode === OrchestrationMode.Aggressive
      ? [
          `shrk dev start "${intent.task}"`,
          `shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json`,
          'shrk plan review /tmp/plan.json',
        ]
      : [
          `shrk dev start "${intent.task}"`,
          `shrk handoff "${intent.task}" --output .sharkcraft/handoff.md`,
          `shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json`,
        ];
  return {
    id: 'plan',
    title: 'Plan',
    purpose: 'Produce a dry-run plan (no writes) and review.',
    recommendedCommands: cmds,
    mcpTools: ['create_generation_plan', 'review_generation_plan'],
    expectedArtifacts: ['plan.json (signed, dry-run)'],
    humanApprovalRequired: false,
    stopConditions: ['No matching template found.', 'Plan signature missing.'],
    safetyNotes:
      mode === OrchestrationMode.Conservative
        ? ['Plan must be reviewed manually before any apply step.']
        : [],
  };
}

function reviewPhase(intent: IChangeIntent, mode: OrchestrationMode): IOrchestrationPhase {
  const cmds = ['shrk plan review /tmp/plan.json', 'shrk impact --since main --format json'];
  if (mode === OrchestrationMode.Conservative) cmds.push(`shrk simulate "${intent.task}"`);
  return {
    id: 'review',
    title: 'Review',
    purpose: 'Surface conflicts, divergence, and boundary impact before any write step.',
    recommendedCommands: cmds,
    mcpTools: ['review_generation_plan', 'get_impact_analysis', 'simulate_workflow'],
    expectedArtifacts: ['impact.json', 'plan-review output'],
    humanApprovalRequired: mode === OrchestrationMode.Conservative,
    stopConditions: ['Plan has conflicts.', 'Boundary violation introduced.'],
    safetyNotes: [],
  };
}

function applyPhase(intent: IChangeIntent, mode: OrchestrationMode): IOrchestrationPhase {
  const writePhase = intent.kind === ChangeIntentKind.Release ? 'release' : 'apply';
  const cmds =
    writePhase === 'release'
      ? ['shrk release readiness --strict', 'shrk release smoke --scenario all', 'shrk release:preflight']
      : [
          'shrk apply /tmp/plan.json --verify-signature --validate --verification typecheck --verification unit-tests',
        ];
  return {
    id: writePhase,
    title: writePhase === 'release' ? 'Release gate' : 'Apply',
    purpose:
      writePhase === 'release'
        ? 'Walk the release gates. Do not publish/tag — those steps are explicit human ones.'
        : 'Apply the reviewed plan via the CLI (the only write path). Requires `--verify-signature`.',
    recommendedCommands: cmds,
    mcpTools: [],
    expectedArtifacts: writePhase === 'release' ? ['release-readiness report'] : ['written files (logged)'],
    humanApprovalRequired: true,
    stopConditions:
      writePhase === 'release'
        ? ['preflight gate fails.', 'readiness has blockers.']
        : ['typecheck or unit-tests fail.', 'divergence detected without --allow-divergent.'],
    safetyNotes: ['MCP must not run this step. Human approval is required.'],
  };
}

function validationPhase(intent: IChangeIntent): IOrchestrationPhase {
  return {
    id: 'validate',
    title: 'Validate',
    purpose: 'Run typecheck + tests + readiness sweep.',
    recommendedCommands: [
      'bun x tsc -p tsconfig.base.json --noEmit',
      'bun test',
      'shrk release readiness',
      `shrk impact --since main`,
    ],
    mcpTools: ['get_release_readiness', 'get_quality_report'],
    expectedArtifacts: ['test output', 'readiness report'],
    humanApprovalRequired: false,
    stopConditions: ['Any of the above fails.'],
    safetyNotes: [],
  };
}

function riskPhase(risk: IRiskSignals, taskRisk?: ITaskRiskReport): IOrchestrationPhase {
  const safetyNotes = [`Risk reasons: ${risk.reasons.join(' · ')}`];
  if (taskRisk) {
    safetyNotes.push(
      `Task risk: ${taskRisk.riskLevel} (score ${taskRisk.score}); ${taskRisk.reasons
        .slice(0, 3)
        .map((r) => r.code)
        .join(', ')}`,
    );
  }
  const commands = [
    'shrk architecture map --risk --signals',
    'shrk architecture violations',
    'shrk policy run --explain-overrides',
    'shrk impact --since main --format json',
  ];
  if (taskRisk && taskRisk.task) commands.unshift(`shrk risk "${taskRisk.task}" --explain`);
  return {
    id: 'risk-review',
    title: 'Risk review',
    purpose: `Risk signals are elevated (${risk.level}${taskRisk ? ` / task ${taskRisk.riskLevel}` : ''}). Surface boundaries, impact, and policy state before generating a plan.`,
    recommendedCommands: commands,
    mcpTools: [
      'get_task_risk_report',
      'get_architecture_map',
      'get_architecture_violations',
      'get_policy_report',
      'get_impact_analysis',
    ],
    expectedArtifacts: ['task risk report', 'architecture map', 'violations report', 'policy report'],
    humanApprovalRequired: true,
    stopConditions: ['Boundary violations at error severity unresolved.', 'Policy errors not overridden.'],
    safetyNotes,
  };
}

export async function buildAgentOrchestrationPlan(
  task: string,
  inspection: ISharkcraftInspection,
  options: IOrchestrationOptions = {},
): Promise<IAgentOrchestrationPlan> {
  const mode = options.mode ?? OrchestrationMode.Balanced;
  const riskAware = options.riskAware === true;
  const intent = await classifyChangeIntent(task, inspection);
  let risk: IRiskSignals | undefined;
  let taskRisk: ITaskRiskReport | undefined;
  if (riskAware) {
    risk = await computeRiskSignals(inspection, { withSignals: true });
    try {
      taskRisk = await buildTaskRiskReport(task, inspection, { includeMemory: true });
    } catch {
      taskRisk = undefined;
    }
  }

  const phases: IOrchestrationPhase[] = [
    discoveryPhase(intent, mode),
    planPhase(intent, mode),
    reviewPhase(intent, mode),
    applyPhase(intent, mode),
    validationPhase(intent),
  ];

  // Inject a risk-review phase between discovery and plan when either
  // global or per-task risk is elevated. The phase is human-approval-gated.
  const taskRiskElevated =
    taskRisk &&
    (taskRisk.riskLevel === TaskRiskLevel.High || taskRisk.riskLevel === TaskRiskLevel.Critical);
  if (risk && (risk.level === RiskLevel.High || risk.level === RiskLevel.Critical || taskRiskElevated)) {
    phases.splice(1, 0, riskPhase(risk, taskRisk));
  }

  const baseCheckpoints =
    mode === OrchestrationMode.Conservative
      ? [
          'Discovery → human reviews brief.',
          'Plan → human reviews plan.json before apply.',
          'Apply → human approves write step.',
          'Validate → human approves test results.',
        ]
      : ['Plan → review plan.', 'Apply → human runs apply (CLI-only).'];
  const reviewCheckpoints =
    risk && (risk.level === RiskLevel.High || risk.level === RiskLevel.Critical || taskRiskElevated)
      ? ['Risk review → human approves before plan.', ...baseCheckpoints]
      : baseCheckpoints;

  return {
    schema: AGENT_ORCHESTRATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    task,
    intent,
    mode,
    phases,
    firstCommand: phases[0]?.recommendedCommands[0] ?? 'shrk start-here',
    forbiddenActions: FORBIDDEN_ACTIONS,
    validationCommands: [
      'bun x tsc -p tsconfig.base.json --noEmit',
      'bun test',
      'shrk release readiness',
    ],
    reviewCheckpoints,
    ...(risk ? { risk } : {}),
    ...(taskRisk ? { taskRisk } : {}),
    riskAware,
  };
}

export function renderOrchestrationText(plan: IAgentOrchestrationPlan): string {
  const lines: string[] = [];
  lines.push('=== Agent orchestration plan ===');
  lines.push(`  task   ${plan.task}`);
  lines.push(`  mode   ${plan.mode}`);
  lines.push(`  intent ${plan.intent.kind} (confidence ${plan.intent.confidence})`);
  lines.push('Phases:');
  for (const p of plan.phases) {
    lines.push(`  ${p.id} — ${p.title}${p.humanApprovalRequired ? ' [HUMAN APPROVAL]' : ''}`);
    for (const c of p.recommendedCommands) lines.push(`    $ ${c}`);
  }
  lines.push('First command:');
  lines.push(`  $ ${plan.firstCommand}`);
  lines.push('Forbidden actions:');
  for (const f of plan.forbiddenActions) lines.push(`  • ${f}`);
  lines.push('Review checkpoints:');
  for (const c of plan.reviewCheckpoints) lines.push(`  • ${c}`);
  return lines.join('\n') + '\n';
}

export function renderOrchestrationMarkdown(plan: IAgentOrchestrationPlan): string {
  const lines: string[] = [];
  lines.push(`# Orchestration plan — ${plan.task}`);
  lines.push('');
  lines.push(`Mode: **${plan.mode}** · intent: **${plan.intent.kind}** · confidence: ${plan.intent.confidence}`);
  lines.push('');
  for (const p of plan.phases) {
    lines.push(`## ${p.title}${p.humanApprovalRequired ? ' (human approval required)' : ''}`);
    lines.push(`_${p.purpose}_`);
    lines.push('');
    if (p.recommendedCommands.length > 0) {
      lines.push('Commands:');
      lines.push('```bash');
      for (const c of p.recommendedCommands) lines.push(c);
      lines.push('```');
    }
    if (p.mcpTools.length > 0) lines.push(`MCP tools: ${p.mcpTools.map((t) => `\`${t}\``).join(', ')}`);
    if (p.expectedArtifacts.length > 0) lines.push(`Artifacts: ${p.expectedArtifacts.join(', ')}`);
    if (p.stopConditions.length > 0) {
      lines.push('Stop if:');
      for (const s of p.stopConditions) lines.push(`- ${s}`);
    }
    lines.push('');
  }
  lines.push('## Forbidden');
  for (const f of plan.forbiddenActions) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## Review checkpoints');
  for (const c of plan.reviewCheckpoints) lines.push(`- ${c}`);
  return lines.join('\n') + '\n';
}
