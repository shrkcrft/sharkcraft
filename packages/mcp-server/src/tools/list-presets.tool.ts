import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listPresetsTool: IToolDefinition = {
  name: 'list_presets',
  description:
    'List all SharkCraft presets (built-in + pack-contributed). A preset is a reusable project setup (knowledge / rules / paths / templates / pipelines / docs) that can be applied via the CLI. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const presets = ctx.inspection.presetRegistry.list();
    const rows = presets.map((p) => ({
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
    }));
    return { data: formatRows(rows, input) };
  },
};
