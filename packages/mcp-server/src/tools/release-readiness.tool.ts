import * as nodePath from 'node:path';
import { buildReleaseReadiness } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getReleaseReadinessTool: IToolDefinition = {
  name: 'get_release_readiness',
  description:
    'Aggregated release-readiness report: doctor + coverage + pack release-check + docs + README/package metadata. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      strict: { type: 'boolean' },
      preflightFile: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const strict = input['strict'] === true;
    const preflightRaw = typeof input['preflightFile'] === 'string' ? (input['preflightFile'] as string) : null;
    const preflight = preflightRaw
      ? nodePath.isAbsolute(preflightRaw)
        ? preflightRaw
        : nodePath.resolve(ctx.cwd, preflightRaw)
      : null;
    const report = await buildReleaseReadiness(ctx.inspection, {
      strict,
      ...(preflight ? { preflightSummaryFile: preflight } : {}),
    });
    return { data: report };
  },
};
