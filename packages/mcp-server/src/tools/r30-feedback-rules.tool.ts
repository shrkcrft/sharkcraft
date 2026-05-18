/**
 * Read-only MCP tools for pack-extensible feedback rules.
 */
import { loadFeedbackRules } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const listFeedbackRulesTool: IToolDefinition = {
  name: 'list_feedback_rules',
  description:
    'List local + pack-contributed feedback rules (schema sharkcraft.feedback-rule/v1). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
  async handler(_input, ctx) {
    const rules = await loadFeedbackRules(ctx.inspection);
    return {
      text: nextHint('shrk feedback rules list'),
      data: { schema: 'sharkcraft.feedback-rule-list/v1', count: rules.length, rules },
    };
  },
};

export const getFeedbackRuleTool: IToolDefinition = {
  name: 'get_feedback_rule',
  description:
    'Return a single feedback rule by id (local or pack-contributed). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const rules = await loadFeedbackRules(ctx.inspection);
    const rule = rules.find((r) => r.id === id);
    return {
      text: nextHint(`shrk feedback rules list`),
      data: {
        schema: 'sharkcraft.feedback-rule-get/v1',
        id,
        found: !!rule,
        rule: rule ?? null,
      },
    };
  },
};
