import { analyzeTestImpact } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getTestImpactTool: IToolDefinition = {
  name: 'get_test_impact',
  description: 'Test impact analysis for changed files. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : undefined;
    const files = Array.isArray(input['files']) ? (input['files'] as string[]) : [];
    return {
      data: analyzeTestImpact(ctx.inspection, {
        ...(task ? { task } : {}),
        files,
      }),
    };
  },
};
