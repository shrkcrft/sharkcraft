import {
  buildOnboardAdoptionDiff,
  renderOnboardAdoptionDiff,
  type OnboardAdoptionDiffFormat,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID_FORMATS = new Set<OnboardAdoptionDiffFormat>(['text', 'markdown', 'html', 'json']);

export const getOnboardAdoptionDiffTool: IToolDefinition = {
  name: 'get_onboard_adoption_diff',
  description:
    'Render a line-level diff of the proposed onboard adoption against the live sharkcraft/*.ts files. Read-only; never writes.',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['text', 'markdown', 'html', 'json'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const formatRaw = typeof input['format'] === 'string' ? (input['format'] as OnboardAdoptionDiffFormat) : 'json';
    const format: OnboardAdoptionDiffFormat = VALID_FORMATS.has(formatRaw) ? formatRaw : 'json';
    const confidence = typeof input['confidence'] === 'string' ? (input['confidence'] as 'high' | 'medium' | 'low') : undefined;
    const diff = buildOnboardAdoptionDiff(ctx.inspection, {
      ...(confidence ? { confidence } : {}),
    });
    return {
      data: {
        diff,
        rendered: renderOnboardAdoptionDiff(diff, format),
        format,
      },
    };
  },
};
