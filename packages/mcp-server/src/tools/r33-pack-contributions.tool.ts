/**
 * Read-only MCP tools for pack contributions inventory + conflicts.
 */
import { buildPackContributionsInventory, selectConflicts } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackContributionsTool: IToolDefinition = {
  name: 'get_pack_contributions',
  description:
    'Inventory of every pack/local contribution across every supported kind, with source attribution + conflict list. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pack: { type: 'string' },
      kind: { type: 'string' },
    },
  },
  async handler(input, ctx) {
    const inv = buildPackContributionsInventory(ctx.inspection);
    let entries = inv.entries;
    if (typeof input.pack === 'string') entries = entries.filter((e) => e.packageName === input.pack);
    if (typeof input.kind === 'string') entries = entries.filter((e) => e.kind === input.kind);
    return { data: { ...inv, entries } };
  },
};

export const getPackConflictsTool: IToolDefinition = {
  name: 'get_pack_conflicts',
  description:
    'Pack contribution conflicts (duplicate ids / shadowed / stale signature, …). Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { severity: { type: 'string' } },
  },
  async handler(input, ctx) {
    const inv = buildPackContributionsInventory(ctx.inspection);
    let conflicts = selectConflicts(inv);
    const sev = typeof input.severity === 'string' ? input.severity : undefined;
    if (sev) conflicts = conflicts.filter((c) => c.severity === sev);
    return { data: { conflicts, totals: inv.totals } };
  },
};
