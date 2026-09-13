import {
  buildPackDoctorReportAsync,
  mergePackReleaseChecks,
  runPackReleaseChecksForReport,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackDoctorReleaseTool: IToolDefinition = {
  name: 'get_pack_doctor_release',
  description:
    'Run packs doctor with the release-check gate folded in. Returns issues + per-pack release checks. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      strict: { type: 'boolean' },
      requireSignatures: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const strict = input['strict'] === true;
    const requireSignatures = input['requireSignatures'] === true;
    // THE async doctor (the one `shrk packs doctor` runs) — registry-backed
    // rejections included (round 12 review, R12-X2).
    const report = await buildPackDoctorReportAsync(ctx.inspection, { requireSignatures });
    const releaseChecks = await runPackReleaseChecksForReport(ctx.inspection);
    mergePackReleaseChecks(ctx.inspection, report, releaseChecks, { strict });
    return { data: report };
  },
};
