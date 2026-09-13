/**
 * Read-only MCP tools for pack contributions inventory + conflicts.
 */
// The ASYNC inventory: loaders consulted, load failures reported. The sync
// wrapper is regex-only and marks every scraped id unverified.
import {
  buildPackContributionsInventoryAsync,
  collectUnresolvableReferences,
  ContributionKind,
  contributionsReportOf,
  filterContributionsReport,
  selectConflicts,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

/** Every contribution kind — what `kind` accepts (the inputSchema enum AND the strict wire validator). */
const CONTRIBUTION_KINDS: readonly string[] = Object.values(ContributionKind);

export const getPackContributionsTool: IToolDefinition = {
  name: 'get_pack_contributions',
  description:
    'Inventory of every pack/local contribution across every loader-backed kind, with source attribution, conflicts, every entry a loader REJECTED (`rejections`), and `report` — per contributed file, entries declared / accepted / rejected and references that cannot be checked (the `shrk packs contributions` By-file report). An unknown `kind` or `pack` is invalid input, never an empty report. Read-only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pack: { type: 'string' },
      kind: { type: 'string', enum: [...CONTRIBUTION_KINDS] },
    },
  },
  async handler(input, ctx) {
    const pack = typeof input.pack === 'string' ? input.pack : undefined;
    const kind = typeof input.kind === 'string' ? input.kind : undefined;
    // An unknown kind or pack narrowed the report to nothing — a clean-looking
    // view over nothing. Refused, as `shrk packs contributions` refuses it
    // (round 12 review, A-1); a direct call bypasses the wire validator.
    if (kind !== undefined && !CONTRIBUTION_KINDS.includes(kind)) {
      return {
        isError: true,
        error: {
          code: 'invalid-input',
          message: `Unknown contribution kind ${JSON.stringify(kind)} — known: ${CONTRIBUTION_KINDS.join(', ')}.`,
        },
      };
    }
    if (pack !== undefined) {
      const known = [...new Set(ctx.inspection.packs.discoveredPacks.map((p) => p.packageName))].sort();
      if (!known.includes(pack)) {
        return {
          isError: true,
          error: {
            code: 'invalid-input',
            message: `Unknown pack ${JSON.stringify(pack)} — ${known.length > 0 ? `discovered: ${known.join(', ')}` : 'no pack was discovered'}.`,
          },
        };
      }
    }
    const inv = await buildPackContributionsInventoryAsync(ctx.inspection);
    let entries = inv.entries;
    let rejections = inv.rejections;
    if (pack) {
      entries = entries.filter((e) => e.packageName === pack);
      rejections = rejections.filter((r) => r.packageName === pack);
    }
    if (kind) {
      entries = entries.filter((e) => e.kind === kind);
      rejections = rejections.filter((r) => r.kind === kind);
    }
    // THE per-file report (round 12, ONE-CHANGE) — additive.
    const report = filterContributionsReport(
      contributionsReportOf(ctx.inspection, inv, await collectUnresolvableReferences(ctx.inspection)),
      { ...(pack ? { pack } : {}), ...(kind ? { kind } : {}) },
    );
    return { data: { ...inv, entries, rejections, report } };
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
    const inv = await buildPackContributionsInventoryAsync(ctx.inspection);
    let conflicts = selectConflicts(inv);
    const sev = typeof input.severity === 'string' ? input.severity : undefined;
    if (sev) conflicts = conflicts.filter((c) => c.severity === sev);
    return { data: { conflicts, totals: inv.totals } };
  },
};
