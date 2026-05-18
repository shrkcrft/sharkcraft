import { buildCoverageReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getCoverageReportTool: IToolDefinition = {
  name: 'get_coverage_report',
  description:
    'Return a relationship/coverage report: templates with descriptions/related, hint coverage on critical entries, pipeline → template links, preset references, boundary suggestedFix, pack docs. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return { data: buildCoverageReport(ctx.inspection) };
  },
};
