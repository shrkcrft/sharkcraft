import { buildContext } from '@shrkcrft/context';
import { buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
export const getRelevantContextTool = {
    name: 'get_relevant_context',
    description: 'Build a token-budgeted, AI-ready context for a task. Returns only relevant rules/paths/templates/etc.',
    inputSchema: {
        type: 'object',
        properties: {
            task: { type: 'string' },
            framework: { type: 'string' },
            area: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            scope: { type: 'array', items: { type: 'string' } },
            maxTokens: { type: 'integer', minimum: 100 },
            includeExamples: { type: 'boolean' },
            includeTemplates: { type: 'boolean' },
            includeRules: { type: 'boolean' },
            includePaths: { type: 'boolean' },
            includeDocs: { type: 'boolean' },
        },
        required: ['task'],
        additionalProperties: false,
    },
    async handler(input, ctx) {
        const overview = buildProjectOverview(ctx.inspection.workspace, ctx.inspection.config?.projectName);
        const result = buildContext(ctx.inspection.knowledgeEntries, {
            task: String(input.task),
            framework: typeof input.framework === 'string' ? input.framework : undefined,
            area: typeof input.area === 'string' ? input.area : undefined,
            tags: input.tags,
            scope: input.scope,
            maxTokens: typeof input.maxTokens === 'number' ? input.maxTokens : undefined,
            includeExamples: input.includeExamples,
            includeTemplates: input.includeTemplates,
            includeRules: input.includeRules,
            includePaths: input.includePaths,
            includeDocs: input.includeDocs,
            projectOverview: renderOverviewText(overview),
        });
        return {
            text: result.body,
            data: {
                totalTokens: result.totalTokens,
                maxTokens: result.maxTokens,
                omittedSections: result.omittedSections,
                sections: result.sections.map((s) => ({
                    title: s.title,
                    tokens: s.tokens,
                    truncated: s.truncated ?? false,
                    entryIds: s.entryIds,
                })),
            },
        };
    },
};
