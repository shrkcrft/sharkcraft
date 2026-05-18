export const searchPathConventionsTool = {
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
            scope: input.scope,
            tags: input.tags,
            limit: typeof input.limit === 'number' ? input.limit : 20,
        });
        return {
            data: results.map((p) => ({
                id: p.id,
                title: p.title,
                path: p.metadata?.path ?? '',
                priority: p.priority,
            })),
        };
    },
};
