import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listRulesTool: IToolDefinition = {
  name: 'list_rules',
  description: 'List all rules with compact metadata. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const rules = ctx.inspection.ruleService.list();
    const rows = rules.map((r) => ({
      id: r.id,
      title: r.title,
      priority: r.priority,
      tags: r.tags,
      scope: r.scope,
      appliesWhen: r.appliesWhen,
      summary: r.summary,
    }));
    return { data: formatRows(rows, input) };
  },
};
