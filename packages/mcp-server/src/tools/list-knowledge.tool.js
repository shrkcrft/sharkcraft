export const listKnowledgeTool = {
    name: 'list_knowledge',
    description: 'Lists available knowledge entries (id, title, type, tags, scope, priority, appliesWhen). Filterable.',
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', description: 'Filter by knowledge type.' },
            types: { type: 'array', items: { type: 'string' } },
            scope: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            appliesWhen: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
    },
    async handler(input, ctx) {
        const types = (Array.isArray(input.types) ? input.types : []).concat(typeof input.type === 'string' ? [input.type] : []);
        const scope = input.scope ?? [];
        const tags = input.tags ?? [];
        const appliesWhen = input.appliesWhen ?? [];
        const limit = typeof input.limit === 'number' ? input.limit : 200;
        let entries = ctx.inspection.knowledgeEntries.slice();
        if (types.length)
            entries = entries.filter((e) => types.includes(String(e.type)));
        if (scope.length)
            entries = entries.filter((e) => scope.some((s) => e.scope.includes(s)));
        if (tags.length)
            entries = entries.filter((e) => tags.every((t) => e.tags.includes(t)));
        if (appliesWhen.length) {
            entries = entries.filter((e) => appliesWhen.some((a) => e.appliesWhen.includes(a)));
        }
        entries = entries.slice(0, limit);
        return {
            data: entries.map((e) => ({
                id: e.id,
                title: e.title,
                type: e.type,
                priority: e.priority,
                scope: e.scope,
                tags: e.tags,
                appliesWhen: e.appliesWhen,
                summary: e.summary,
            })),
        };
    },
};
