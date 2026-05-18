import type { IToolDefinition } from '../server/tool-definition.ts';
import { formatEntryFull } from '@shrkcrft/knowledge';

export const getKnowledgeTool: IToolDefinition = {
  name: 'get_knowledge',
  description: 'Get one knowledge entry by id with full content.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const entry = ctx.inspection.index.get(id);
    if (!entry) return { isError: true, text: `No knowledge entry with id "${id}"` };
    return { data: entry, text: formatEntryFull(entry) };
  },
};
