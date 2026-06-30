import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackTool: IToolDefinition = {
  name: 'get_pack',
  description:
    'Get one discovered pack by package name. Returns manifest info, contribution counts, validation issues, post-install notes. Does not embed full contribution file contents.',
  inputSchema: {
    type: 'object',
    properties: { packageName: { type: 'string' } },
    required: ['packageName'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.packageName ?? '');
    const pack = ctx.inspection.packs.discoveredPacks.find((p) => p.packageName === id);
    if (!pack) return { isError: true, text: `No pack with packageName "${id}" was discovered.` };
    return {
      data: {
        packageName: pack.packageName,
        packageVersion: pack.packageVersion,
        valid: pack.valid,
        manifestPath: pack.manifestPath,
        packageRoot: pack.packageRoot,
        info: pack.manifest?.info,
        contributionCounts: pack.contributionCounts,
        resolvedCounts: pack.resolvedCounts,
        signatureStatus: pack.signatureStatus,
        signatureMessage: pack.signatureMessage,
        signatureDev: pack.signatureDev,
        validationIssues: pack.validationIssues,
        loadError: pack.loadError,
        postInstallNotes: pack.manifest?.postInstallNotes ?? [],
      },
    };
  },
};
