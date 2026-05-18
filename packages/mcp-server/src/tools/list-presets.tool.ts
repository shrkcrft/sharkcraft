import type { IToolDefinition } from '../server/tool-definition.ts';

export const listPresetsTool: IToolDefinition = {
  name: 'list_presets',
  description:
    'List all SharkCraft presets (built-in + pack-contributed). A preset is a reusable project setup (knowledge / rules / paths / templates / pipelines / docs) that can be applied via the CLI.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const presets = ctx.inspection.presetRegistry.list();
    return {
      data: presets.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        tags: p.tags ?? [],
        appliesTo: p.appliesTo ?? [],
        weight: p.weight ?? 5,
        source: ctx.inspection.presetSources.get(p.id) ?? null,
        counts: {
          knowledge: p.includes.knowledge?.length ?? 0,
          rules: p.includes.rules?.length ?? 0,
          paths: p.includes.paths?.length ?? 0,
          templates: p.includes.templates?.length ?? 0,
          pipelines: p.includes.pipelines?.length ?? 0,
        },
      })),
    };
  },
};
