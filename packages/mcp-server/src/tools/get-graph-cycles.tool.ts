import { GraphQueryApi, GraphStore, loadGraphApiCached } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

const NEXT = 'shrk graph index';

interface ICyclesInput {
  /** Hard cap on returned cycles. Default 50. */
  limit?: number;
  /** Minimum SCC size; default 2 (any cycle). */
  minSize?: number;
}

/**
 * Read-only MCP mirror of `shrk graph cycles`. Returns the full SCC
 * list (sorted by size desc) so agents can answer "show me every
 * import cycle in this repo" in a single tool call. Mirrors the safety
 * contract: read-only, structured error with nextCommand when state
 * is missing.
 */
export const getGraphCyclesTool: IToolDefinition = {
  name: 'get_graph_cycles',
  description:
    'Return every import cycle in the code graph (strongly-connected components of size ≥ 2 over `imports-file` edges). Sorted by size desc. Read-only.',
  cliCommand: 'graph cycles',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number' },
      minSize: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as ICyclesInput;
    const rawLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? args.limit
        : 50;
    const minSize =
      typeof args.minSize === 'number' && Number.isFinite(args.minSize) && args.minSize >= 2
        ? args.minSize
        : 2;

    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: `Code-intelligence index is missing. Run '${NEXT}'.`,
          details: { nextCommand: NEXT },
        },
      };
    }
    const api = loadGraphApiCached(ctx.inspection.projectRoot) ?? GraphQueryApi.fromStore(ctx.inspection.projectRoot);
    const all = api.cycles();
    const filtered = all.filter((c) => c.size >= minSize);
    const limited = filtered.slice(0, rawLimit);
    const data = {
      schema: 'sharkcraft.graph-cycles/v1',
      total: filtered.length,
      truncated: filtered.length > rawLimit,
      cycles: limited.map((c) => ({
        size: c.size,
        paths: c.paths ?? c.nodeIds.map((id) => id.replace(/^file:/, '')),
      })),
    };
    return { data: formatObjectArrays(data, input) };
  },
};
