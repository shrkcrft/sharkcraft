import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPathConventionTool: IToolDefinition = {
  name: 'get_path_convention',
  description: 'Get one path convention by id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const p = ctx.inspection.pathService.get(id);
    if (!p) return { isError: true, text: `No path convention with id "${id}"` };
    return { data: p };
  },
};
