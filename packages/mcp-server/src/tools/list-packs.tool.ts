import type { IToolDefinition } from '../server/tool-definition.ts';

export const listPacksTool: IToolDefinition = {
  name: 'list_packs',
  description:
    'List discovered SharkCraft packs (third-party npm packages that ship knowledge / templates / pipelines). Each entry includes both declared file counts and resolved object counts after dedup.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return {
      data: ctx.inspection.packs.discoveredPacks.map((p) => ({
        packageName: p.packageName,
        packageVersion: p.packageVersion,
        valid: p.valid,
        contributionCounts: p.contributionCounts,
        resolvedCounts: p.resolvedCounts,
        signatureStatus: p.signatureStatus,
        signatureMessage: p.signatureMessage,
        loadError: p.loadError,
      })),
    };
  },
};
