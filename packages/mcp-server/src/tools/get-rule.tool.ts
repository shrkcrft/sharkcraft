import type { IToolDefinition } from '../server/tool-definition.ts';
import { formatRuleFull } from '@shrkcrft/rules';

export const getRuleTool: IToolDefinition = {
  name: 'get_rule',
  description: 'Get one rule by id with full content.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const rule = ctx.inspection.ruleService.get(id);
    if (!rule) return { isError: true, text: `No rule with id "${id}"` };
    return { data: rule, text: formatRuleFull(rule) };
  },
};
