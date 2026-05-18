import type { IToolDefinition } from '../server/tool-definition.ts';
import { KnowledgeType } from '@shrkcrft/knowledge';

export const getSecurityGuidelinesTool: IToolDefinition = {
  name: 'get_security_guidelines',
  description: 'Return security-related rules and warnings.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const entries = ctx.inspection.knowledgeEntries.filter((e) => {
      if (String(e.type) === KnowledgeType.Security || String(e.type) === KnowledgeType.Warning) {
        return true;
      }
      return e.tags.some((t) => ['security', 'safety', 'auth'].includes(t.toLowerCase()));
    });
    return {
      data: entries.map((e) => ({
        id: e.id,
        title: e.title,
        type: e.type,
        priority: e.priority,
        content: e.content,
      })),
    };
  },
};
