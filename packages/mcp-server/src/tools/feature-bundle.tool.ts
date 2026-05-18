import {
  listFeatureBundles,
  readFeatureBundle,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listFeatureBundlesTool: IToolDefinition = {
  name: 'list_feature_bundles',
  description: 'List feature workflow bundles stored under .sharkcraft/bundles. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const all = listFeatureBundles(ctx.cwd);
    return {
      data: all.map((b) => ({
        id: b.id,
        task: b.task,
        status: b.status,
        risk: b.riskLevel,
        plans: b.plans.length,
        nextAction: b.nextAction,
      })),
    };
  },
};

export const getFeatureBundleTool: IToolDefinition = {
  name: 'get_feature_bundle',
  description: 'Read a feature workflow bundle by id. Read-only.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const id = String(input['id'] ?? '');
    const b = readFeatureBundle(ctx.cwd, id);
    if (!b) return { isError: true, text: `No bundle "${id}".` };
    return { data: b };
  },
};
