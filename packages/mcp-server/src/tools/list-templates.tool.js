export const listTemplatesTool = {
    name: 'list_templates',
    description: 'List available generator templates.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
        const templates = ctx.inspection.templateRegistry.list();
        return {
            data: templates.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                tags: t.tags,
                scope: t.scope,
                appliesWhen: t.appliesWhen,
                variableCount: t.variables.length,
            })),
        };
    },
};
