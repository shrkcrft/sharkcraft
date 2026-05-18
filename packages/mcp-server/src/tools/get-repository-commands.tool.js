import { KnowledgeType } from '@shrkcrft/knowledge';
export const getRepositoryCommandsTool = {
    name: 'get_repository_commands',
    description: 'Return known package scripts (from package.json) and documented commands (from knowledge entries of type "command").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
        const scripts = ctx.inspection.workspace.scripts;
        const documented = ctx.inspection.knowledgeEntries.filter((e) => String(e.type) === KnowledgeType.Command);
        return {
            data: {
                scripts,
                documented: documented.map((d) => ({
                    id: d.id,
                    title: d.title,
                    summary: d.summary,
                    content: d.content,
                    tags: d.tags,
                })),
            },
        };
    },
};
