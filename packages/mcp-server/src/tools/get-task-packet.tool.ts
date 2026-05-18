import { buildTaskPacket } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getTaskPacketTool: IToolDefinition = {
  name: 'get_task_packet',
  description:
    'Full machine task packet (project overview, detected profiles, recommended pipelines, relevant rules/paths/templates, action hints, recommended CLI/MCP, forbidden actions, verification commands, human-review checkpoints, token-budgeted context body). **Prefer `prepare_agent_task` for first task grounding** — it returns the curated agent bundle plus next-safe-action. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      maxTokens: { type: 'number', minimum: 100, maximum: 20000 },
      scope: { type: 'array', items: { type: 'string' } },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = String((input as { task?: unknown }).task ?? '').trim();
    if (!task) return { isError: true, text: 'task is required' };
    const maxTokens = Number((input as { maxTokens?: unknown }).maxTokens ?? 3500);
    const scope = (input as { scope?: unknown }).scope as string[] | undefined;
    const packet = buildTaskPacket(ctx.inspection, task, {
      maxTokens,
      ...(scope ? { scope } : {}),
    });
    return {
      data: {
        task: packet.task,
        detectedProfiles: packet.detectedProfiles,
        recommendedPipelines: packet.recommendedPipelines,
        presetRecommendations: packet.presetRecommendations.map((r) => ({
          presetId: r.preset.id,
          confidence: r.confidence,
          score: r.score,
        })),
        relevantRules: packet.relevantRules.map((r) => ({ id: r.id, title: r.title })),
        relevantPaths: packet.relevantPaths.map((p) => ({ id: p.id, title: p.title })),
        relevantTemplates: packet.relevantTemplates.map((t) => ({ id: t.id, name: t.name })),
        recommendedMcpTools: packet.recommendedMcpTools,
        recommendedCliCommands: packet.recommendedCliCommands,
        forbiddenActions: packet.forbiddenActions,
        verificationCommands: packet.verificationCommands,
        humanReviewPoints: packet.humanReviewPoints,
        tokenEstimate: packet.tokenEstimate,
        context: packet.context,
      },
    };
  },
};
