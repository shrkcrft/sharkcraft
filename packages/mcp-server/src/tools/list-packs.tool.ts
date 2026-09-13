import { buildPackContributionsInventoryAsync, packEntryCounts } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listPacksTool: IToolDefinition = {
  name: 'list_packs',
  description:
    'List discovered SharkCraft packs (third-party npm packages that ship knowledge / templates / pipelines). Each entry includes declared file counts, resolved object counts after dedup, and `entryCounts` — per contribution kind, files / accepted / REJECTED entries. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // THE contributions inventory (round 12, 12.1b): per-kind accepted and
    // rejected entries, the same projection `shrk packs list` prints.
    const inv =
      ctx.inspection.packs.validPacks.length > 0 ? await buildPackContributionsInventoryAsync(ctx.inspection) : null;
    const rows = ctx.inspection.packs.discoveredPacks.map((p) => ({
      packageName: p.packageName,
      packageVersion: p.packageVersion,
      valid: p.valid,
      contributionCounts: p.contributionCounts,
      resolvedCounts: p.resolvedCounts,
      entryCounts: packEntryCounts(inv, p),
      signatureStatus: p.signatureStatus,
      signatureMessage: p.signatureMessage,
      signatureDev: p.signatureDev,
      loadError: p.loadError,
    }));
    return { data: formatRows(rows, input) };
  },
};
