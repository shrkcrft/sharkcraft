import {
  diffImpactReports,
  ImpactReportStore,
} from '@shrkcrft/impact-engine';
import type { IToolDefinition } from '../server/tool-definition.ts';

/**
 * Read-only MCP mirror of `shrk impact baseline show`. Returns the
 * frozen baseline + the most recent run + the delta between them.
 * When either side is missing the response carries a structured hint
 * pointing at the command that fills the gap.
 */
export const getImpactBaselineTool: IToolDefinition = {
  name: 'get_impact_baseline',
  description:
    'Return the impact baseline + latest impact run + delta. Read-only mirror of `shrk impact baseline show`.',
  cliCommand: 'impact baseline show',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler(_input, ctx) {
    const store = new ImpactReportStore(ctx.inspection.projectRoot);
    const baseline = store.readBaseline();
    const last = store.read();
    if (!baseline && !last) {
      return {
        data: {
          schema: 'sharkcraft.impact-baseline/v1',
          state: 'missing-both',
          baseline: null,
          last: null,
          nextCommands: ['shrk impact --via-graph <target>', 'shrk impact baseline write'],
        },
      };
    }
    if (!baseline) {
      return {
        data: {
          schema: 'sharkcraft.impact-baseline/v1',
          state: 'missing-baseline',
          baseline: null,
          last,
          nextCommands: ['shrk impact baseline write'],
        },
      };
    }
    if (!last) {
      return {
        data: {
          schema: 'sharkcraft.impact-baseline/v1',
          state: 'missing-last',
          baseline,
          last: null,
          nextCommands: ['shrk impact --via-graph <target>'],
        },
      };
    }
    const delta = diffImpactReports(baseline, last);
    return {
      data: {
        schema: 'sharkcraft.impact-baseline/v1',
        state: 'present',
        baseline,
        last,
        delta,
      },
    };
  },
};
