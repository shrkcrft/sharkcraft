import type { IToolDefinition } from '../server/tool-definition.ts';
import { KnowledgeType } from '@shrkcrft/knowledge';

export const getTestingGuidelinesTool: IToolDefinition = {
  name: 'get_testing_guidelines',
  description: 'Return testing-related rules and conventions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const entries = ctx.inspection.knowledgeEntries.filter((e) => {
      if (String(e.type) === KnowledgeType.Testing) return true;
      return e.tags.some((t) => t.toLowerCase().includes('test'));
    });
    return {
      data: entries.map((e) => ({
        id: e.id,
        title: e.title,
        priority: e.priority,
        content: e.content,
        tags: e.tags,
      })),
    };
  },
};
