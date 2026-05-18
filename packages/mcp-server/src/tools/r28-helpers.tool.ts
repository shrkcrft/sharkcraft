/**
 * Read-only helper previews.
 *
 *  list_helpers
 *  get_helper
 *  preview_helper_plan
 */
import { buildHelperPlan, HELPERS, HelperId } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const listHelpersTool: IToolDefinition = {
  name: 'list_helpers',
  description: 'List available helpers from the helper registry. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  handler() {
    return {
      text: nextHint('shrk helper list'),
      data: HELPERS,
    };
  },
};

export const getHelperTool: IToolDefinition = {
  name: 'get_helper',
  description: 'Get a helper definition (variables, safety flags). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' } },
  },
  handler(input) {
    const id = String(input.id ?? '');
    const def = HELPERS.find((h) => h.id === id);
    if (!def) {
      return { text: `Unknown helper id: ${id}`, data: null };
    }
    return {
      text: nextHint(`shrk helper get ${id}`),
      data: def,
    };
  },
};

export const previewHelperPlanTool: IToolDefinition = {
  name: 'preview_helper_plan',
  description: 'Preview a helper plan. Read-only — returns the plan, never writes.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string' },
      vars: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
  handler(input, ctx) {
    const id = String(input.id ?? '') as HelperId;
    const vars = (input.vars && typeof input.vars === 'object'
      ? (input.vars as Record<string, string>)
      : {}) as Record<string, string>;
    try {
      const plan = buildHelperPlan({ helperId: id, projectRoot: ctx.cwd, vars });
      return {
        text: nextHint(`shrk helper plan ${id} --var ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(' ')}`),
        data: plan,
      };
    } catch (e) {
      return { text: `${(e as Error).message}`, data: null };
    }
  },
};
