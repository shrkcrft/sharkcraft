import { buildDriftReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getDriftReportTool: IToolDefinition = {
  name: 'get_drift_report',
  description:
    'Detect architecture drift: boundary violations, broken preset references, pipeline/template links, missing pack assets. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      skipBoundaries: { type: 'boolean', description: 'Skip the import scan (faster, no boundary findings).' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const skip = (input as { skipBoundaries?: unknown }).skipBoundaries === true;
    return { data: buildDriftReport(ctx.inspection, { runBoundaries: !skip }) };
  },
};
