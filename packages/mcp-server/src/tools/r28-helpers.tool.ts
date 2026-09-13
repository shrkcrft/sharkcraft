/**
 * Read-only helper previews.
 *
 *  list_helpers
 *  get_helper
 *  preview_helper_plan
 *
 * All three read THE helper catalog (`listAllHelpers`) — built-in helpers ∪
 * pack/local-contributed ones — the same list `shrk helper list` prints.
 * Inputs are unchanged, so the MCP input schemas stay as they are.
 */
import {
  buildHelperPlan,
  buildPackHelperPlan,
  findHelper,
  HelperId,
  listAllHelpers,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

function nextHint(cmd: string): string {
  return `Next: \`${cmd}\` (CLI is the only write path).`;
}

export const listHelpersTool: IToolDefinition = {
  name: 'list_helpers',
  description: 'List available helpers from the helper registry. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    const catalog = await listAllHelpers(ctx.inspection);
    return {
      text: nextHint('shrk helper list'),
      data: catalog.entries,
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
  async handler(input, ctx) {
    const id = String(input.id ?? '');
    const def = await findHelper(ctx.inspection, id);
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
  async handler(input, ctx) {
    const id = String(input.id ?? '') as HelperId;
    const vars = (input.vars && typeof input.vars === 'object'
      ? (input.vars as Record<string, string>)
      : {}) as Record<string, string>;
    const helper = await findHelper(ctx.inspection, id);
    if (!helper) return { text: `Unknown helper id: ${id}`, data: null };
    if (helper.source !== 'builtin') {
      // Pack/local helpers render their DECLARATIVE operations — no pack code runs.
      const built = buildPackHelperPlan(helper, vars);
      if (!built.ok) return { text: built.message, data: { missing: built.missing } };
      return {
        text: nextHint(`shrk helper plan ${id}${Object.entries(vars).map(([k, v]) => ` --var ${k}=${v}`).join('')}`),
        data: built.plan,
      };
    }
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
