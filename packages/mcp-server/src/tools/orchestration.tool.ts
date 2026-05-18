import {
  buildAgentOrchestrationPlan,
  OrchestrationMode,
  simulateWorkflow,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const createAgentOrchestrationPlanTool: IToolDefinition = {
  name: 'create_agent_orchestration_plan',
  description:
    'Produce a read-only agent orchestration plan (discovery / plan / review / apply / validate). No execution; no writes.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      mode: { type: 'string' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const modeRaw = typeof input['mode'] === 'string' ? (input['mode'] as string).toLowerCase() : '';
    const mode =
      modeRaw === 'conservative'
        ? OrchestrationMode.Conservative
        : modeRaw === 'aggressive'
          ? OrchestrationMode.Aggressive
          : OrchestrationMode.Balanced;
    const plan = await buildAgentOrchestrationPlan(task, ctx.inspection, { mode });
    return { data: plan };
  },
};

export const simulateWorkflowTool: IToolDefinition = {
  name: 'simulate_workflow',
  description: 'Predict what a workflow would do without executing anything. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      playbookId: { type: 'string' },
      pipelineId: { type: 'string' },
      mode: { type: 'string' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const playbookId = typeof input['playbookId'] === 'string' ? (input['playbookId'] as string) : undefined;
    const pipelineId = typeof input['pipelineId'] === 'string' ? (input['pipelineId'] as string) : undefined;
    const modeRaw = typeof input['mode'] === 'string' ? (input['mode'] as string).toLowerCase() : '';
    const mode =
      modeRaw === 'conservative'
        ? OrchestrationMode.Conservative
        : modeRaw === 'aggressive'
          ? OrchestrationMode.Aggressive
          : OrchestrationMode.Balanced;
    const sim = await simulateWorkflow(task, ctx.inspection, {
      ...(playbookId ? { playbookId } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      mode,
    });
    return { data: sim };
  },
};
