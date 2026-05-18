import * as nodePath from 'node:path';
import { checkPackSymbolCompat } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackCompatReportTool: IToolDefinition = {
  name: 'get_pack_compat_report',
  description:
    'Diff a pack\'s @shrkcrft/plugin-api imports against the consumer\'s installed plugin-api exports. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['packPath'],
    properties: {
      packPath: { type: 'string' },
      consumerRoot: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const packRaw = typeof input['packPath'] === 'string' ? (input['packPath'] as string) : '';
    const consumerRaw = typeof input['consumerRoot'] === 'string' ? (input['consumerRoot'] as string) : null;
    const packPath = nodePath.isAbsolute(packRaw) ? packRaw : nodePath.resolve(ctx.cwd, packRaw);
    const consumerRoot = consumerRaw
      ? nodePath.isAbsolute(consumerRaw)
        ? consumerRaw
        : nodePath.resolve(ctx.cwd, consumerRaw)
      : null;
    const report = checkPackSymbolCompat({ packPath, consumerRoot });
    return { data: report };
  },
};
