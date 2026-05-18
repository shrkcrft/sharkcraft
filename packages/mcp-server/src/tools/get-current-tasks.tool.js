import { KnowledgeType } from '@shrkcrft/knowledge';
export const getCurrentTasksTool = {
    name: 'get_current_tasks',
    description: 'Return current tasks/roadmap entries (knowledge entries of type "task" or sourced from tasks/*.md).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
        const tasks = ctx.inspection.knowledgeEntries.filter((e) => String(e.type) === KnowledgeType.Task ||
            (e.source?.origin && e.source.origin.includes('/tasks/')));
        return {
            data: tasks.map((t) => ({
                id: t.id,
                title: t.title,
                priority: t.priority,
                source: t.source?.origin,
                content: t.content,
            })),
        };
    },
};
