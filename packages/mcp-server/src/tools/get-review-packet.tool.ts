import { buildReviewPacket } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getReviewPacketTool: IToolDefinition = {
  name: 'get_review_packet',
  description:
    'Build a PR-review packet from a git diff selection (--since, --staged, or explicit files). Returns changed files, affected paths, relevant rules/templates/pipelines, boundary violations on those files, missing-test heuristic, verification commands, AI reviewer instructions. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const since = (input as { since?: unknown }).since;
    const staged = (input as { staged?: unknown }).staged === true;
    const files = (input as { files?: unknown }).files;
    return {
      data: buildReviewPacket(ctx.inspection, {
        ...(typeof since === 'string' ? { since } : {}),
        ...(staged ? { staged } : {}),
        ...(Array.isArray(files) ? { files: files.filter((f) => typeof f === 'string') as string[] } : {}),
      }),
    };
  },
};
