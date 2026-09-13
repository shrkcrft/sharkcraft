import type { IToolDefinition } from '../server/tool-definition.ts';
import { formatEntryFull } from '@shrkcrft/knowledge';
import { buildKnowledgeRefResolver, warmReferenceRegistries } from '@shrkcrft/inspector';

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
    // The text form names the namespace each cross-reference resolves into and
    // opens a superseded entry with its successor — the same resolver the CLI
    // injects. Read-only: warming only loads registries. `data` is unchanged.
    await warmReferenceRegistries(ctx.inspection);
    return {
      data: entry,
      text: formatEntryFull(entry, { resolveRef: buildKnowledgeRefResolver(ctx.inspection) }),
    };
  },
};
