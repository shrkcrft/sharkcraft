/**
 * MCP read-only sibling for `shrk knowledge propose`.
 *
 * Same payload shape as the CLI's `--json` mode. Never writes; the CLI
 * is the only path that materialises drafts. Tier-gated through the
 * sibling-command mechanism.
 */
import { proposeKnowledge } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const previewKnowledgeProposeTool: IToolDefinition = {
  name: 'preview_knowledge_propose',
  description:
    'Preview proposed knowledge entries for exported top-level constructs without an existing entry. Read-only mirror of `shrk knowledge propose`.',
  cliCommand: 'knowledge propose',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Restrict scan to a single file (project-relative or absolute).',
      },
      symbol: {
        type: 'string',
        description: 'Propose only for a single named symbol.',
      },
      since: {
        type: 'string',
        description:
          'Git ref; restrict scan to files changed since this ref. Default HEAD. Pass empty string to scan the whole workspace.',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const path = typeof input.path === 'string' ? input.path : undefined;
    const symbol = typeof input.symbol === 'string' ? input.symbol : undefined;
    const sinceRaw = typeof input.since === 'string' ? input.since : undefined;
    const since = sinceRaw === '' ? null : sinceRaw;
    const report = await proposeKnowledge({
      cwd: ctx.cwd,
      ...(path ? { path } : {}),
      ...(symbol ? { symbol } : {}),
      ...(since !== undefined ? { since } : {}),
    });
    return { data: report };
  },
};
