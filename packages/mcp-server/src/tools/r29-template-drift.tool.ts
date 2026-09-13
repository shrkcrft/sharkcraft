/**
 * Read-only MCP tool: get_template_drift_report.
 */
import { buildTemplateDriftReport, warmReferenceRegistries } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getTemplateDriftReportTool: IToolDefinition = {
  name: 'get_template_drift_report',
  description:
    'Verify every registered template against the workspace (forbidden legacy paths, missing barrels, anchors, unresolved related ids). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      templateId: { type: 'string' },
      packId: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    // Warm first: `related` ids are resolved against EVERY registry, and a cold
    // construct / playbook registry would otherwise report them NOT VERIFIED.
    await warmReferenceRegistries(ctx.inspection);
    const report = buildTemplateDriftReport(ctx.inspection, {
      ...(typeof input.templateId === 'string' ? { templateId: input.templateId } : {}),
      ...(typeof input.packId === 'string' ? { packId: input.packId } : {}),
    });
    return {
      text: nextHint('shrk templates drift'),
      data: report,
    };
  },
};
