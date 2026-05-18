import {
  buildConstructAdoptionPlan,
  InferredConstructConfidence,
  loadConstructs,
  readConstructAdoptionStatus,
  type ConstructAdoptionIncludes,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const createConstructAdoptionPlanTool: IToolDefinition = {
  name: 'create_construct_adoption_plan',
  description:
    'Build a construct-adoption plan classifying inferred construct drafts. Read-only; never writes patches.',
  inputSchema: {
    type: 'object',
    properties: {
      minConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      include: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    await loadConstructs(ctx.inspection);
    const min =
      typeof input['minConfidence'] === 'string'
        ? (input['minConfidence'] as InferredConstructConfidence)
        : undefined;
    const include = Array.isArray(input['include'])
      ? ((input['include'] as string[]).filter((x) =>
          ['facets', 'publicApi', 'events', 'tokens'].includes(x),
        ) as ConstructAdoptionIncludes[])
      : undefined;
    const plan = await buildConstructAdoptionPlan(ctx.inspection, {
      ...(min ? { minConfidence: min } : {}),
      ...(include ? { include } : {}),
    });
    return { data: plan };
  },
};

export const getConstructAdoptionReviewTool: IToolDefinition = {
  name: 'get_construct_adoption_review',
  description: 'Return the current construct-adoption status (paths + summary). Read-only.',
  inputSchema: { type: 'object', properties: {} },
  async handler(_input, ctx) {
    await loadConstructs(ctx.inspection);
    const status = readConstructAdoptionStatus(ctx.inspection);
    return { data: status };
  },
};
