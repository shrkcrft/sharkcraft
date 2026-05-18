import type { IToolDefinition } from '../server/tool-definition.ts';

export const getBoundaryRuleTool: IToolDefinition = {
  name: 'get_boundary_rule',
  description: 'Get one boundary rule by id with full details.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const rule = ctx.inspection.boundaryRegistry.get(id);
    if (!rule) return { isError: true, text: `No boundary rule with id "${id}".` };
    return {
      data: {
        ...rule,
        source: ctx.inspection.boundarySources.get(id) ?? null,
      },
    };
  },
};
