import { buildBundleDiffFromIds, renderBundleDiff, type BundleDiffFormat } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID_FORMATS = new Set<BundleDiffFormat>(['text', 'markdown', 'html', 'json']);

export const getBundleDiffTool: IToolDefinition = {
  name: 'get_bundle_diff',
  description:
    'Diff two feature bundles by id (plans, deps, validations, affected files). Read-only.',
  inputSchema: {
    type: 'object',
    required: ['a', 'b'],
    properties: {
      a: { type: 'string' },
      b: { type: 'string' },
      format: { type: 'string', enum: ['text', 'markdown', 'html', 'json'] },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const a = typeof input['a'] === 'string' ? (input['a'] as string) : '';
    const b = typeof input['b'] === 'string' ? (input['b'] as string) : '';
    const formatRaw = typeof input['format'] === 'string' ? (input['format'] as BundleDiffFormat) : 'json';
    const format: BundleDiffFormat = VALID_FORMATS.has(formatRaw) ? formatRaw : 'json';
    const result = buildBundleDiffFromIds(ctx.cwd, a, b);
    if ('error' in result) {
      return {
        isError: true,
        text: result.error,
        error: { code: 'not-found', message: result.error },
      };
    }
    return {
      data: {
        diff: result,
        rendered: renderBundleDiff(result, format),
        format,
      },
    };
  },
};
