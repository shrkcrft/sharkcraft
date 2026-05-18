import { impactFor, loadOwnershipRules, matchFile } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getOwnershipTool: IToolDefinition = {
  name: 'get_ownership',
  description: 'List loaded ownership rules. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const cfg = (ctx.inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const r = await loadOwnershipRules(ctx.cwd, cfg);
    return { data: r };
  },
};

export const matchOwnersTool: IToolDefinition = {
  name: 'match_owners',
  description: 'Match files against ownership rules. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const files = Array.isArray(input['files']) ? (input['files'] as string[]) : [];
    const cfg = (ctx.inspection.config as { ownershipFiles?: readonly string[] } | null)?.ownershipFiles;
    const { rules } = await loadOwnershipRules(ctx.cwd, cfg);
    if (files.length === 1) {
      return { data: matchFile(files[0]!, rules) };
    }
    return { data: impactFor(files, rules) };
  },
};
