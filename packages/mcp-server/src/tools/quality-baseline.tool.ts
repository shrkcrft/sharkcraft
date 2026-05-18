import { compareQualityBaseline } from '@shrkcrft/inspector';
import * as nodePath from 'node:path';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getQualityBaselineComparisonTool: IToolDefinition = {
  name: 'get_quality_baseline_comparison',
  description: 'Compare current quality to a baseline file. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      baselineFile: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const file = typeof input['baselineFile'] === 'string'
      ? (input['baselineFile'] as string)
      : nodePath.join(ctx.cwd, 'sharkcraft', 'quality-baseline.json');
    const cmp = await compareQualityBaseline(ctx.inspection, file);
    if (!cmp) return { isError: true, text: `No baseline at ${file}` };
    return { data: cmp };
  },
};
