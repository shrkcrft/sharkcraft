import type { IToolDefinition } from '../server/tool-definition.ts';
import { searchKnowledge } from '@shrkcrft/knowledge';

export const searchKnowledgeTool: IToolDefinition = {
  name: 'search_knowledge',
  description: 'Search knowledge entries by query/tags/types/scope/appliesWhen.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      types: { type: 'array', items: { type: 'string' } },
      scope: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      appliesWhen: { type: 'array', items: { type: 'string' } },
      minPriority: { type: 'string' },
      limit: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const limit = typeof input.limit === 'number' ? input.limit : 20;
    const results = searchKnowledge(ctx.inspection.knowledgeEntries, {
      query: typeof input.query === 'string' ? input.query : undefined,
      types: input.types as string[] | undefined,
      scope: input.scope as string[] | undefined,
      tags: input.tags as string[] | undefined,
      appliesWhen: input.appliesWhen as string[] | undefined,
      minPriority: typeof input.minPriority === 'string' ? input.minPriority : undefined,
      limit,
    });
    return {
      data: results.map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        score: r.score,
        type: r.entry.type,
        priority: r.entry.priority,
        tags: r.entry.tags,
        scope: r.entry.scope,
        reasons: r.reasons,
      })),
    };
  },
};
