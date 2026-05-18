import { evaluatePolicy } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPolicyReportTool: IToolDefinition = {
  name: 'get_policy_report',
  description: 'Run the policy engine (boundaries, ownership, plans, packs). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const r = await evaluatePolicy(ctx.inspection);
    return { data: r };
  },
};
