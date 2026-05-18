import type { IToolDefinition } from '../server/tool-definition.ts';

export const searchTemplatesTool: IToolDefinition = {
  name: 'search_templates',
  description: 'Search templates by free-text query.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const results = ctx.inspection.templateRegistry.search(String(input.query ?? ''));
    return {
      data: results.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
      })),
    };
  },
};
