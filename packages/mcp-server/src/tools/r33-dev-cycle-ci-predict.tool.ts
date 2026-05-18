/**
 * Read-only MCP tools for dev cycle plan + CI predict.
 */
import {
  buildCiPredictReport,
  CiPredictProfileId,
  DevCycleProfileId,
  planDevCycle,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getDevCyclePlanTool: IToolDefinition = {
  name: 'get_dev_cycle_plan',
  description: 'Return the deterministic dev cycle plan for a profile. Read-only — never runs commands.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      profile: { type: 'string' },
    },
  },
  async handler(input, _ctx) {
    const profile = typeof input.profile === 'string' ? (input.profile as DevCycleProfileId) : DevCycleProfileId.SharkcraftSelf;
    const plan = planDevCycle(profile);
    if (!plan) return { isError: true, error: { code: 'invalid-input', message: `Unknown dev cycle profile "${profile}".` } };
    return { data: plan };
  },
};

export const getCiPredictionTool: IToolDefinition = {
  name: 'get_ci_prediction',
  description:
    'Predict likely CI gate outcomes from `.sharkcraft/reports/` JSON files. Read-only — does not run commands.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      profile: { type: 'string' },
      reportsDir: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const profile = typeof input.profile === 'string' ? (input.profile as CiPredictProfileId) : CiPredictProfileId.GithubPr;
    const reportsDir = typeof input.reportsDir === 'string' ? (input.reportsDir as string) : undefined;
    const report = buildCiPredictReport({
      projectRoot: ctx.cwd,
      profileId: profile,
      ...(reportsDir ? { reportsDir } : {}),
    });
    return { data: report };
  },
};
