import { buildArchitectureMap, type ArchitectureMapInclude } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getArchitectureMapTool: IToolDefinition = {
  name: 'get_architecture_map',
  description: 'Build an architecture map: layers, constructs, boundary rules, public-API surfaces, tests/ownership hints, risks. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      include: { type: 'array', items: { type: 'string' } },
      risk: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const include = Array.isArray(input['include']) ? (input['include'] as ArchitectureMapInclude[]) : undefined;
    const risk = input['risk'] === true ? true : undefined;
    const map = await buildArchitectureMap(ctx.inspection, {
      ...(include ? { include } : {}),
      ...(risk !== undefined ? { risk } : {}),
    });
    return { data: map };
  },
};
