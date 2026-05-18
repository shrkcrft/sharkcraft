import type { IToolDefinition } from '../server/tool-definition.ts';
import {
  aggregateActionHints,
  aggregatedHintsToText,
  KnowledgeIndex,
  type IKnowledgeEntry,
} from '@shrkcrft/knowledge';

export const getActionHintsTool: IToolDefinition = {
  name: 'get_action_hints',
  description:
    'Aggregate action hints (CLI commands, MCP tools, preferred flow, forbidden actions, verification commands, related templates / path conventions, human review markers) from knowledge entries relevant to a task. Use this when you need a single answer to "what should I do next?".',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Natural-language task description.' },
      entryIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional explicit list of knowledge entry ids to aggregate from. Skips the relevance search.',
      },
      limit: { type: 'integer', minimum: 1, default: 10 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const explicitIds = (input.entryIds as string[] | undefined) ?? [];
    let entries: IKnowledgeEntry[] = [];

    if (explicitIds.length) {
      for (const id of explicitIds) {
        const entry = ctx.inspection.index.get(id);
        if (entry) entries.push(entry);
      }
    } else if (typeof input.task === 'string' && input.task.length > 0) {
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      const idx = new KnowledgeIndex(ctx.inspection.knowledgeEntries);
      const results = idx.search({ query: input.task, limit });
      entries = results.map((r) => r.entry);
    } else {
      entries = ctx.inspection.knowledgeEntries.slice();
    }

    const hints = aggregateActionHints(entries);
    return {
      data: hints,
      text: aggregatedHintsToText(hints),
    };
  },
};
