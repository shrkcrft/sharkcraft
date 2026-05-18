import * as nodePath from 'node:path';
import { reviewSavedPlan } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const reviewGenerationPlanTool: IToolDefinition = {
  name: 'review_generation_plan',
  description:
    'Review a saved generation plan (sharkcraft.plan/v1 JSON). Returns files to create/update, signature status, related path conventions, missing-tests heuristic, boundary concerns, verification commands. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { planPath: { type: 'string' } },
    required: ['planPath'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const planPath = String((input as { planPath?: unknown }).planPath ?? '');
    try {
      const abs = nodePath.isAbsolute(planPath)
        ? planPath
        : nodePath.resolve(ctx.inspection.projectRoot, planPath);
      return { data: reviewSavedPlan(ctx.inspection, abs) };
    } catch (e) {
      return { isError: true, text: `Failed to review plan: ${(e as Error).message}` };
    }
  },
};
