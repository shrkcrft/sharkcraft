import type { IToolDefinition } from '../server/tool-definition.ts';


export const searchPathConventionsTool: IToolDefinition = {
  name: 'search_path_conventions',
  description: 'Search path conventions by query/scope/tags.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const results = ctx.inspection.pathService.search({
      query: typeof input.query === 'string' ? input.query : undefined,
      scope: input.scope as string[] | undefined,
      tags: input.tags as string[] | undefined,
      limit: typeof input.limit === 'number' ? input.limit : 20,
    });
    return {
      data: results.map((p) => ({
        id: p.id,
        title: p.title,
        path: (p.metadata?.path as string | undefined) ?? '',
        priority: p.priority,
      })),
    };
  },
};
