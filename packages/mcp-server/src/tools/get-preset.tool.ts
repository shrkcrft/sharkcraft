import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPresetTool: IToolDefinition = {
  name: 'get_preset',
  description:
    'Get one preset by id. Returns the full definition including includes, recommendedNextCommands, postInstallNotes, and safety notes.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const preset = ctx.inspection.presetRegistry.get(id);
    if (!preset) return { isError: true, text: `No preset with id "${id}".` };
    return {
      data: {
        ...preset,
        source: ctx.inspection.presetSources.get(id) ?? null,
      },
    };
  },
};
