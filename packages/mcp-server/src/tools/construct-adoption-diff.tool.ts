import {
  buildConstructAdoptionDiff,
  loadConstructs,
  renderConstructAdoptionDiff,
  type ConstructAdoptionDiffFormat,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID_FORMATS = new Set<ConstructAdoptionDiffFormat>(['text', 'markdown', 'html', 'json']);

export const getConstructAdoptionDiffTool: IToolDefinition = {
  name: 'get_construct_adoption_diff',
  description:
    'Render a line-level diff of the proposed construct adoption against the live constructs registry. Read-only; never writes.',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['text', 'markdown', 'html', 'json'] },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    await loadConstructs(ctx.inspection);
    const formatRaw = typeof input['format'] === 'string' ? (input['format'] as ConstructAdoptionDiffFormat) : 'json';
    const format: ConstructAdoptionDiffFormat = VALID_FORMATS.has(formatRaw) ? formatRaw : 'json';
    const diff = await buildConstructAdoptionDiff(ctx.inspection);
    return {
      data: {
        diff,
        rendered: renderConstructAdoptionDiff(diff, format),
        format,
      },
    };
  },
};
