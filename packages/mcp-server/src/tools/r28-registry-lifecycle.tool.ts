/**
 * Read-only registry lifecycle report.
 */
import { buildRegistryLifecycleReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getRegistryLifecycleReportTool: IToolDefinition = {
  name: 'get_registry_lifecycle_report',
  description:
    'Scan the workspace for register*/remove* symmetry. Returns matched pairs, missing removers, and ignored sites. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'number' },
    },
  },
  handler(input, ctx) {
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const report = buildRegistryLifecycleReport({
      projectRoot: ctx.cwd,
      ...(limit ? { limit } : {}),
    });
    return {
      text: nextHint('shrk check registry-lifecycle'),
      data: report,
    };
  },
};
