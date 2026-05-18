import { buildReviewPacketV2 } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getReviewPacketV2Tool: IToolDefinition = {
  name: 'get_review_packet_v2',
  description: 'Build the v2 review packet (impact, ownership, policy, quality comparison). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
      qualityBaselineFile: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const opts: Record<string, unknown> = {};
    if (typeof input['since'] === 'string') opts['since'] = input['since'];
    if (input['staged'] === true) opts['staged'] = true;
    if (Array.isArray(input['files'])) opts['files'] = input['files'];
    if (typeof input['qualityBaselineFile'] === 'string')
      opts['qualityBaselineFile'] = input['qualityBaselineFile'];
    return { data: await buildReviewPacketV2(ctx.inspection, opts) };
  },
};
