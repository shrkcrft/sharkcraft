import { buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getProjectOverviewTool: IToolDefinition = {
  name: 'get_project_overview',
  description: 'Returns a compact project overview (name, package manager, frameworks, top-level dirs).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const overview = buildProjectOverview(ctx.inspection.workspace, ctx.inspection.config?.projectName);
    return { text: renderOverviewText(overview), data: overview };
  },
};
