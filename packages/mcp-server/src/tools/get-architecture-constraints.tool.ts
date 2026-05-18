import type { IToolDefinition } from '../server/tool-definition.ts';
import { KnowledgeType } from '@shrkcrft/knowledge';

export const getArchitectureConstraintsTool: IToolDefinition = {
  name: 'get_architecture_constraints',
  description: 'Return architecture-related knowledge entries (type "architecture" or "decision").',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const entries = ctx.inspection.knowledgeEntries.filter(
      (e) =>
        String(e.type) === KnowledgeType.Architecture || String(e.type) === KnowledgeType.Decision,
    );
    return {
      data: entries.map((e) => ({
        id: e.id,
        title: e.title,
        type: e.type,
        priority: e.priority,
        summary: e.summary,
        content: e.content,
        tags: e.tags,
      })),
    };
  },
};
