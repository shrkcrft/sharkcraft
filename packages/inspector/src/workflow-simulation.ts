/**
 * Safe workflow simulation.
 *
 * Predicts what a workflow would do without executing it. Builds on the
 * orchestration plan + (optionally) a playbook/pipeline to surface:
 * phases, commands that would be suggested, files that might be touched,
 * policies likely to be checked, validations that would run, human-
 * review points, and a risk summary.
 *
 * Read-only. No commands executed. No files written except --output by
 * the caller.
 */
import { OrchestrationMode, buildAgentOrchestrationPlan, type IAgentOrchestrationPlan } from './agent-orchestration.ts';
import { listPlaybooks, loadPlaybooks } from './playbook-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const WORKFLOW_SIMULATION_SCHEMA = 'sharkcraft.workflow-simulation/v1';

export interface IWorkflowSimulationStep {
  phaseId: string;
  command: string;
  expectedSafetyLevel: 'read-only' | 'writes-drafts' | 'writes-session' | 'writes-source' | 'runs-shell';
  mayWriteFiles: boolean;
}

export interface IWorkflowSimulation {
  schema: typeof WORKFLOW_SIMULATION_SCHEMA;
  generatedAt: string;
  task: string;
  plan: IAgentOrchestrationPlan;
  playbookId?: string;
  pipelineId?: string;
  predictedSteps: readonly IWorkflowSimulationStep[];
  predictedFiles: readonly string[];
  predictedPolicies: readonly string[];
  predictedValidations: readonly string[];
  humanReviewPoints: readonly string[];
  predictedArtifacts: readonly string[];
  riskSummary: readonly string[];
  notes: readonly string[];
}

export interface IWorkflowSimulationOptions {
  playbookId?: string;
  pipelineId?: string;
  bundle?: boolean;
  mode?: OrchestrationMode;
}

const COMMAND_SAFETY_HINTS: ReadonlyMap<RegExp, IWorkflowSimulationStep['expectedSafetyLevel']> = new Map([
  [/^shrk (gen|init|apply|import|presets apply --write|packs (sign|new))/i, 'writes-source'],
  [/^shrk (onboard|brief|dev start|handoff|export|report site|impact|review packet|ci scaffold)/i, 'writes-drafts'],
  [/^shrk (session|dev report|dev open)/i, 'writes-session'],
  [/^bun |^npm |^node |^git /i, 'runs-shell'],
  [/^shrk /i, 'read-only'],
]);

function classifyCommand(c: string): IWorkflowSimulationStep['expectedSafetyLevel'] {
  for (const [re, level] of COMMAND_SAFETY_HINTS) if (re.test(c)) return level;
  return 'read-only';
}

export async function simulateWorkflow(
  task: string,
  inspection: ISharkcraftInspection,
  options: IWorkflowSimulationOptions = {},
): Promise<IWorkflowSimulation> {
  await loadPlaybooks(inspection);
  void inspection;
  const plan = await buildAgentOrchestrationPlan(task, inspection, {
    mode: options.mode ?? OrchestrationMode.Balanced,
  });
  const steps: IWorkflowSimulationStep[] = [];
  for (const phase of plan.phases) {
    for (const c of phase.recommendedCommands) {
      const safety = classifyCommand(c);
      steps.push({
        phaseId: phase.id,
        command: c,
        expectedSafetyLevel: safety,
        mayWriteFiles: safety === 'writes-source' || safety === 'writes-drafts',
      });
    }
  }

  let playbookId: string | undefined;
  let pipelineId: string | undefined;
  const notes: string[] = [];

  if (options.playbookId) {
    const pb = listPlaybooks(inspection).find((p) => p.id === options.playbookId);
    if (pb) {
      playbookId = pb.id;
      for (const s of pb.steps ?? []) {
        for (const c of (s as { commands?: readonly string[] }).commands ?? []) {
          const safety = classifyCommand(c);
          steps.push({
            phaseId: `playbook:${pb.id}`,
            command: c,
            expectedSafetyLevel: safety,
            mayWriteFiles: safety === 'writes-source' || safety === 'writes-drafts',
          });
        }
      }
    } else {
      notes.push(`Playbook "${options.playbookId}" not found.`);
    }
  }
  if (options.pipelineId) {
    const pl = inspection.pipelines.find((p) => p.id === options.pipelineId);
    if (pl) {
      pipelineId = pl.id;
      for (const s of pl.steps ?? []) {
        const c = (s as { command?: string }).command ?? '';
        if (!c) continue;
        const safety = classifyCommand(c);
        steps.push({
          phaseId: `pipeline:${pl.id}`,
          command: c,
          expectedSafetyLevel: safety,
          mayWriteFiles: safety === 'writes-source' || safety === 'writes-drafts',
        });
      }
    } else {
      notes.push(`Pipeline "${options.pipelineId}" not found.`);
    }
  }

  const predictedFiles: string[] = [];
  if (plan.intent.likelyTemplates.length > 0) {
    for (const t of plan.intent.likelyTemplates) predictedFiles.push(`(template:${t}) target file would be rendered to a location per templates.ts targetPath`);
  }
  const predictedPolicies = plan.intent.kind === 'policy' || plan.intent.kind === 'release'
    ? ['policy:run', 'safety:audit', 'readiness:strict']
    : ['safety:audit'];

  const humanReviewPoints = plan.phases.filter((p) => p.humanApprovalRequired).map((p) => p.title);

  const predictedArtifacts: string[] = [];
  for (const p of plan.phases) for (const a of p.expectedArtifacts) predictedArtifacts.push(`${p.id}/${a}`);

  const risks: string[] = [];
  if (plan.intent.requiredHumanReview) risks.push('Task requires explicit human review before apply.');
  if (steps.some((s) => s.expectedSafetyLevel === 'writes-source'))
    risks.push('Plan contains write-source steps (apply / init / gen --write / presets apply --write).');
  if (steps.some((s) => s.expectedSafetyLevel === 'runs-shell')) risks.push('Plan suggests shell-out commands (bun/npm/node/git).');

  return {
    schema: WORKFLOW_SIMULATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    task,
    plan,
    ...(playbookId ? { playbookId } : {}),
    ...(pipelineId ? { pipelineId } : {}),
    predictedSteps: steps,
    predictedFiles,
    predictedPolicies,
    predictedValidations: plan.validationCommands,
    humanReviewPoints,
    predictedArtifacts,
    riskSummary: risks,
    notes,
  };
}

export function renderWorkflowSimulationText(sim: IWorkflowSimulation): string {
  const lines: string[] = [];
  lines.push('=== Workflow simulation ===');
  lines.push(`  task     ${sim.task}`);
  lines.push(`  intent   ${sim.plan.intent.kind} / ${sim.plan.intent.confidence}`);
  if (sim.playbookId) lines.push(`  playbook ${sim.playbookId}`);
  if (sim.pipelineId) lines.push(`  pipeline ${sim.pipelineId}`);
  lines.push(`  steps    ${sim.predictedSteps.length}`);
  lines.push(`  human review points ${sim.humanReviewPoints.length}`);
  if (sim.riskSummary.length > 0) {
    lines.push('Risks:');
    for (const r of sim.riskSummary) lines.push(`  • ${r}`);
  }
  lines.push('Predicted steps:');
  for (const s of sim.predictedSteps.slice(0, 30)) {
    lines.push(`  [${s.expectedSafetyLevel.padEnd(14)}] (${s.phaseId}) ${s.command}`);
  }
  if (sim.notes.length > 0) {
    lines.push('Notes:');
    for (const n of sim.notes) lines.push(`  • ${n}`);
  }
  return lines.join('\n') + '\n';
}
