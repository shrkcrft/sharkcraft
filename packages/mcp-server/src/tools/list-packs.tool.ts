import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listPacksTool: IToolDefinition = {
  name: 'list_packs',
  description:
    'List discovered SharkCraft packs (third-party npm packages that ship knowledge / templates / pipelines). Each entry includes both declared file counts and resolved object counts after dedup. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const rows = ctx.inspection.packs.discoveredPacks.map((p) => ({
      packageName: p.packageName,
      packageVersion: p.packageVersion,
      valid: p.valid,
      contributionCounts: p.contributionCounts,
      resolvedCounts: p.resolvedCounts,
      signatureStatus: p.signatureStatus,
      signatureMessage: p.signatureMessage,
      loadError: p.loadError,
    }));
    return { data: formatRows(rows, input) };
  },
};
