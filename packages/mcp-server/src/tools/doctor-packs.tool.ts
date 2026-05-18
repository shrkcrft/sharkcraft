import { buildPackDoctorReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const doctorPacksTool: IToolDefinition = {
  name: 'doctor_packs',
  description:
    'Validate pack discovery: invalid manifests, missing contribution files, empty contributions, duplicate ids, template/pipeline quality, action-hint coverage, and (optionally) signatures. Mirrors `shrk packs doctor`.',
  inputSchema: {
    type: 'object',
    properties: {
      requireSignatures: {
        type: 'boolean',
        description: 'If true, treat unsigned packs as warnings.',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const requireSignatures = (input as { requireSignatures?: unknown }).requireSignatures === true;
    const report = buildPackDoctorReport(ctx.inspection, { requireSignatures });
    return {
      data: {
        passed: report.passed,
        packsChecked: report.packsChecked,
        summary: report.summary,
        discoveredPackCount: ctx.inspection.packs.discoveredPacks.length,
        validPackCount: ctx.inspection.packs.validPacks.length,
        invalidPackCount: ctx.inspection.packs.invalidPacks.length,
        issues: report.issues,
      },
    };
  },
};
