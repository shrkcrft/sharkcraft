import { classifyChangeIntent } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const classifyChangeIntentTool: IToolDefinition = {
  name: 'classify_change_intent',
  description:
    'Classify the change intent for a task (deterministic, no AI). Returns kind, domains, likely constructs/templates/pipelines, risk hints, requiredHumanReview, suggested first command, and confidence. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : '';
    const intent = await classifyChangeIntent(task, ctx.inspection);
    return { data: intent };
  },
};
