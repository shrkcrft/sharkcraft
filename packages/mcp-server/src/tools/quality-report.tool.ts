import {
  buildQualityReport,
  type IQualityConfig,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IQualityInput {
  strict?: unknown;
  requireBoundaryClean?: unknown;
  requireDriftClean?: unknown;
  requireAgentTests?: unknown;
  requireContextTests?: unknown;
  requirePackSignatures?: unknown;
  minReadiness?: unknown;
}

function toBool(v: unknown): boolean | undefined {
  if (v === true) return true;
  if (v === false) return false;
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export const getQualityReportTool: IToolDefinition = {
  name: 'get_quality_report',
  description:
    'Run the SharkCraft quality gate read-only and return the structured report. Aggregates doctor / readiness / boundaries / coverage / drift / context-tests / agent-tests / packs / cross-references / knowledge-stale gates — the knowledge stale-check is the same gate `shrk quality` settles. NEVER executes shell commands: the data-defined gate planes (some spawn shells) are NOT evaluated here, so a config declaring any plane rule adds a `gate-planes` row with `executed: false` and `overall` is `not-verified`, never `pass` — run `shrk quality` for the full bundle.',
  inputSchema: {
    type: 'object',
    properties: {
      strict: { type: 'boolean', description: 'Promote warnings to blockers (mirrors CLI --strict).' },
      requireBoundaryClean: { type: 'boolean' },
      requireDriftClean: { type: 'boolean' },
      requireAgentTests: { type: 'boolean' },
      requireContextTests: { type: 'boolean' },
      requirePackSignatures: { type: 'boolean' },
      minReadiness: { type: 'number' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const obj = input as IQualityInput;
    const config: IQualityConfig = {};
    const min = toNumber(obj.minReadiness);
    if (min !== undefined) config.minReadiness = min;
    if (toBool(obj.requireBoundaryClean)) config.requireBoundaryClean = true;
    if (toBool(obj.requireDriftClean)) config.requireDriftClean = true;
    if (toBool(obj.requireAgentTests)) config.requireAgentTests = true;
    if (toBool(obj.requireContextTests)) config.requireContextTests = true;
    if (toBool(obj.requirePackSignatures)) config.requirePackSignatures = true;
    const strict = toBool(obj.strict) === true;
    const report = await buildQualityReport({
      inspection: ctx.inspection,
      config,
      strict,
      // MCP is strictly non-executing.
      skipShell: true,
    });
    return {
      data: {
        ...report,
        note:
          'MCP cannot execute shell commands. To re-run shell-heavy gates locally use `shrk quality --strict`.',
        nextCommand: 'shrk quality --strict',
      },
    };
  },
};
