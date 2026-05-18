import type { IToolDefinition } from '../server/tool-definition.ts';
import { resolveTargetPath } from '@shrkcrft/templates';
import { buildNameVariables } from '@shrkcrft/generator';

export const explainGenerationTargetTool: IToolDefinition = {
  name: 'explain_generation_target',
  description: 'Explain where a generated file would go and why (based on the template and the closest path convention).',
  inputSchema: {
    type: 'object',
    properties: {
      templateId: { type: 'string' },
      name: { type: 'string' },
      variables: { type: 'object', additionalProperties: { type: 'string' } },
      task: { type: 'string' },
    },
    required: ['templateId'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const t = ctx.inspection.templateRegistry.get(String(input.templateId));
    if (!t) return { isError: true, text: `No template with id "${input.templateId}"` };

    const nameVars = typeof input.name === 'string' ? buildNameVariables(input.name) : {};
    const values = { ...nameVars, ...((input.variables as Record<string, string> | undefined) ?? {}) };
    const resolved = resolveTargetPath(t, values, ctx.inspection.projectRoot);

    const task = typeof input.task === 'string' ? input.task : `generate ${t.id}`;
    const bestPath = ctx.inspection.pathService.findBestForTask(task);

    return {
      data: {
        template: { id: t.id, name: t.name, description: t.description },
        resolved: resolved
          ? {
              rawPath: resolved.rawPath,
              absolutePath: resolved.absolutePath,
              isInsideProject: resolved.isInsideProject,
            }
          : null,
        bestPathConvention: bestPath
          ? {
              id: bestPath.convention.id,
              title: bestPath.convention.title,
              path: (bestPath.convention.metadata?.path as string | undefined) ?? '',
              reason: bestPath.reason,
              score: bestPath.score,
            }
          : null,
        notes: t.postGenerationNotes ?? [],
      },
    };
  },
};
