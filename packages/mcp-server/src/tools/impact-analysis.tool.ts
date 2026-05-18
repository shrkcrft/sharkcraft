import { analyzeImpact, ImpactInputKind } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getImpactAnalysisTool: IToolDefinition = {
  name: 'get_impact_analysis',
  description:
    'Architecture impact analysis for a task / files / specifier. Computes direct + transitive dependents via the import graph and classifies risk. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      specifier: { type: 'string' },
      planTargets: { type: 'array', items: { type: 'string' } },
      maxDepth: { type: 'number' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : undefined;
    const files = Array.isArray(input['files']) ? (input['files'] as string[]) : [];
    const specifier =
      typeof input['specifier'] === 'string' ? (input['specifier'] as string) : undefined;
    const planTargets = Array.isArray(input['planTargets'])
      ? (input['planTargets'] as string[])
      : [];
    const maxDepth =
      typeof input['maxDepth'] === 'number' ? (input['maxDepth'] as number) : undefined;
    const limit = typeof input['limit'] === 'number' ? (input['limit'] as number) : undefined;
    const data = await analyzeImpact(ctx.inspection, {
      ...(task ? { task } : {}),
      files,
      planTargets,
      ...(specifier ? { specifier } : {}),
      ...(maxDepth ? { maxDepth } : {}),
      ...(limit ? { limit } : {}),
      inputKind: specifier
        ? ImpactInputKind.Specifier
        : files.length > 0
          ? ImpactInputKind.Files
          : task
            ? ImpactInputKind.Task
            : ImpactInputKind.Empty,
    });
    return { data };
  },
};
