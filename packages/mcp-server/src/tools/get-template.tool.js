export const getTemplateTool = {
    name: 'get_template',
    description: 'Get one template by id, including variables and notes.',
    inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
    },
    async handler(input, ctx) {
        const id = String(input.id ?? '');
        const t = ctx.inspection.templateRegistry.get(id);
        if (!t)
            return { isError: true, text: `No template with id "${id}"` };
        return {
            data: {
                id: t.id,
                name: t.name,
                description: t.description,
                tags: t.tags,
                scope: t.scope,
                appliesWhen: t.appliesWhen,
                variables: t.variables,
                postGenerationNotes: t.postGenerationNotes ?? [],
                related: t.related ?? [],
            },
        };
    },
};
