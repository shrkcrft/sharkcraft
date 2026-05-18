import { buildRepositoryMap, type MapInclude } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getRepositoryMapTool: IToolDefinition = {
  name: 'get_repository_map',
  description: 'Return a high-level repository structural map. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      include: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const include = Array.isArray(input['include']) ? (input['include'] as MapInclude[]) : undefined;
    const map = await buildRepositoryMap(ctx.inspection, { ...(include ? { include } : {}) });
    return { data: map };
  },
};
