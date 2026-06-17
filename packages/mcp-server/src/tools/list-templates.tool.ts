import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listTemplatesTool: IToolDefinition = {
  name: 'list_templates',
  description: 'List available generator templates. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const templates = ctx.inspection.templateRegistry.list();
    const rows = templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      tags: t.tags,
      scope: t.scope,
      appliesWhen: t.appliesWhen,
      variableCount: t.variables.length,
    }));
    return { data: formatRows(rows, input) };
  },
};
