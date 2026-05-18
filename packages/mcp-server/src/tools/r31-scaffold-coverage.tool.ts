/**
 * Read-only MCP tool for scaffold coverage gaps.
 */
import { buildScaffoldCoverageReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getScaffoldCoverageReportTool: IToolDefinition = {
  name: 'get_scaffold_coverage_report',
  description:
    'Coverage-gap analysis for a task/domain across knowledge/rules/paths/templates/scaffold-patterns/playbooks/helpers/validation-commands. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      task: { type: 'string' },
      domain: { type: 'string' },
      topN: { type: 'number' },
    },
  },
  async handler(input, ctx) {
    const task = typeof input.task === 'string' ? input.task : undefined;
    const domain = typeof input.domain === 'string' ? input.domain : undefined;
    const topN = typeof input.topN === 'number' ? input.topN : 8;
    const report = await buildScaffoldCoverageReport(ctx.inspection, {
      ...(task ? { task } : {}),
      ...(domain ? { domain } : {}),
      topN,
    });
    return {
      text: `Next: \`shrk coverage scaffolds --task "${task ?? domain ?? '<task>'}"\``,
      data: report,
    };
  },
};
