/**
 * Read-only MCP tool for fuzzy impact resolution.
 *
 * Returns the same `IFuzzyImpactResolution` shape the CLI computes. Never
 * runs the impact engine itself — the human/agent runs `shrk impact
 * <query>` on the CLI.
 */
import { resolveFuzzyImpact, warmConstructCache } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const getFuzzyImpactReportTool: IToolDefinition = {
  name: 'get_fuzzy_impact_report',
  description:
    'Resolve a free-form impact query against files / constructs / plugin keys / symbols / templates / helpers / playbooks / knowledge / commands. Returns the resolution + alternatives + suggested follow-up commands. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
      resolveOnly: { type: 'boolean' },
    },
  },
  async handler(input, ctx) {
    const query = String(input.query ?? '');
    try {
      await warmConstructCache(ctx.inspection);
    } catch {
      // best-effort
    }
    const limit = typeof input.limit === 'number' ? input.limit : undefined;
    const resolveOnly = Boolean(input.resolveOnly);
    const resolution = resolveFuzzyImpact(ctx.inspection, query, {
      ...(limit ? { limit } : {}),
      resolveOnly,
    });
    return {
      text: nextHint(`shrk impact ${query}${resolveOnly ? ' --resolve-only' : ''}`),
      data: resolution,
    };
  },
};
