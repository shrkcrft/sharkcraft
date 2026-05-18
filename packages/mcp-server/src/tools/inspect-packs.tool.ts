import type { IToolDefinition } from '../server/tool-definition.ts';

export const inspectPacksTool: IToolDefinition = {
  name: 'inspect_packs',
  description: 'Pack-discovery overview: scanned package count, valid/invalid counts, warnings.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const { packs } = ctx.inspection;
    const totals = { entries: 0, templates: 0, pipelines: 0, docs: 0 };
    for (const p of packs.validPacks) {
      const r = p.resolvedCounts;
      if (!r) continue;
      totals.entries += r.knowledgeEntries + r.rules + r.pathConventions;
      totals.templates += r.templates;
      totals.pipelines += r.pipelines;
      totals.docs += r.docs;
    }
    return {
      data: {
        projectRoot: packs.projectRoot,
        nodeModulesPath: packs.nodeModulesPath,
        nodeModulesExists: packs.nodeModulesExists,
        scannedPackageCount: packs.scannedPackageCount,
        discoveredPackCount: packs.discoveredPacks.length,
        validPackCount: packs.validPacks.length,
        invalidPackCount: packs.invalidPacks.length,
        resolvedTotals: totals,
        warnings: packs.warnings,
      },
    };
  },
};
