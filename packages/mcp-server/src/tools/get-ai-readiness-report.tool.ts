import type { IToolDefinition } from '../server/tool-definition.ts';
import { buildAiReadinessReport } from '@shrkcrft/inspector';

export const getAiReadinessReportTool: IToolDefinition = {
  name: 'get_ai_readiness_report',
  description:
    'Deterministic 0..100 score reporting how AI-ready the SharkCraft setup is. Dimensions cover config/knowledge/rules/paths/templates/pipelines/action hints/safety/doctor/packs. Returns score, grade, per-dimension breakdown, top recommendations.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const report = buildAiReadinessReport(ctx.inspection);
    return { data: report };
  },
};
