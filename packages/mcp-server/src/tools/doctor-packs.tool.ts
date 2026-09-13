import { buildPackDoctorReportAsync, packDoctorVerdict } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const doctorPacksTool: IToolDefinition = {
  name: 'doctor_packs',
  description:
    'Validate pack discovery: invalid manifests, missing contribution files, empty contributions, duplicate ids, template/pipeline quality, action-hint coverage, and (optionally) signatures. Mirrors `shrk packs doctor` — the same settled verdict: zero packs, or a compiled build never compared to its source, is `not-verified` (exitCode 2), never `passed`.',
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
    // THE async doctor `shrk packs doctor` runs: the registry loaders' load
    // failures and REJECTED entries are gathered first. The sync builder saw
    // only the inspection-time loaders, so a pack whose conventions were all
    // refused passed here while the CLI exited 1 (round 12 review, R12-X2).
    const report = await buildPackDoctorReportAsync(ctx.inspection, { requireSignatures });
    // THE pack-doctor settlement (`packDoctorVerdict`) — the one `shrk packs
    // doctor` exits on. `passed` is the SETTLED verdict, exactly as the CLI's
    // `--json` reports it: a run that verified nothing is not `passed`.
    const verdict = packDoctorVerdict(report, ctx.inspection);
    return {
      data: {
        passed: verdict.exit === 0,
        packsChecked: report.packsChecked,
        summary: report.summary,
        discoveredPackCount: ctx.inspection.packs.discoveredPacks.length,
        validPackCount: ctx.inspection.packs.validPacks.length,
        invalidPackCount: ctx.inspection.packs.invalidPacks.length,
        issues: report.issues,
        exitCode: verdict.exit,
        verdict: verdict.verdict,
        shortfalls: verdict.shortfalls,
      },
    };
  },
};
