/**
 * Read-only MCP tools: resolve_query / trace_query.
 */
import { QueryMatchKind, resolveQuery } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

const KIND_VALUES = Object.values(QueryMatchKind);

export const resolveQueryTool: IToolDefinition = {
  name: 'resolve_query',
  description:
    'Resolve a free-form query against files / constructs / knowledge / templates / helpers / playbooks / policies / commands. **For agent first-task grounding prefer `prepare_agent_task`**; use `resolve_query` for ad-hoc lookups. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
      kinds: { type: 'array', items: { type: 'string', enum: KIND_VALUES } },
    },
  },
  async handler(input, ctx) {
    const query = String(input.query ?? '');
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const kinds = Array.isArray(input.kinds) ? (input.kinds as QueryMatchKind[]) : undefined;
    const resolution = resolveQuery(ctx.inspection, query, {
      ...(limit ? { limit } : {}),
      ...(kinds ? { kinds } : {}),
    });
    return { text: nextHint(`shrk trace ${query}`), data: resolution };
  },
};

export const traceQueryTool: IToolDefinition = {
  name: 'trace_query',
  description:
    'Alias for resolve_query. Returns the same resolution structure for parity with the CLI `shrk trace <query>`. Read-only.',
  inputSchema: resolveQueryTool.inputSchema,
  handler: resolveQueryTool.handler,
};
