export const listRulesTool = {
    name: 'list_rules',
    description: 'List all rules with compact metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
        const rules = ctx.inspection.ruleService.list();
        return {
            data: rules.map((r) => ({
                id: r.id,
                title: r.title,
                priority: r.priority,
                tags: r.tags,
                scope: r.scope,
                appliesWhen: r.appliesWhen,
                summary: r.summary,
            })),
        };
    },
};
