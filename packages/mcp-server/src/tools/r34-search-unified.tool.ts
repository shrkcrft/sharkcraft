/**
 * Read-only MCP tool for unified search.
 */
import { buildUniversalSearch } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const searchUnifiedTool: IToolDefinition = {
  name: 'search_unified',
  description:
    'Universal search palette across every contribution kind. Returns the 7-section unified output + uncertainty footer. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string' },
      kind: { type: 'string' },
      source: { type: 'string' },
      limit: { type: 'number' },
      commandsOnly: { type: 'boolean' },
      actionsOnly: { type: 'boolean' },
    },
  },
  async handler(input, ctx) {
    const query = typeof input.query === 'string' ? (input.query as string) : '';
    if (!query) return { isError: true, error: { code: 'invalid-input', message: 'query is required' } };
    const opts: Record<string, unknown> = {};
    if (typeof input.kind === 'string') opts.kind = input.kind;
    if (typeof input.source === 'string') opts.source = input.source;
    if (typeof input.limit === 'number') opts.limit = input.limit;
    if (input.commandsOnly === true) opts.commandsOnly = true;
    if (input.actionsOnly === true) opts.actionsOnly = true;
    return { data: await buildUniversalSearch(ctx.inspection, query, opts as Parameters<typeof buildUniversalSearch>[2]) };
  },
};
