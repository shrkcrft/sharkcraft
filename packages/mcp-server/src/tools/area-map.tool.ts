import { buildAreaMap } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getRepoAreaMapTool: IToolDefinition = {
  name: 'get_repo_area_map',
  description: 'Repository area map: paths, areas, file counts, related rules/templates. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    return { data: buildAreaMap(ctx.inspection) };
  },
};
