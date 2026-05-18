import type { IToolDefinition } from '../server/tool-definition.ts';
import { formatRulesForAi } from '@shrkcrft/rules';

export const getRelevantRulesTool: IToolDefinition = {
  name: 'get_relevant_rules',
  description: 'Return rules relevant to the current task. Optionally include scope/tags/appliesWhen.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      appliesWhen: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer', minimum: 1 },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const rules = ctx.inspection.ruleService.getRelevant(String(input.task), {
      scope: input.scope as string[] | undefined,
      tags: input.tags as string[] | undefined,
      appliesWhen: input.appliesWhen as string[] | undefined,
      limit: typeof input.limit === 'number' ? input.limit : 10,
    });
    return {
      data: rules.map((r) => ({
        id: r.id,
        title: r.title,
        priority: r.priority,
        tags: r.tags,
        appliesWhen: r.appliesWhen,
        content: r.content,
        actionHints: r.actionHints,
      })),
      text: formatRulesForAi(rules),
    };
  },
};
