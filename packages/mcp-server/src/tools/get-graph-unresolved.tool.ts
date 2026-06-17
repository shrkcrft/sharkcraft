import { EdgeKind, GraphStore, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

const NEXT = 'shrk graph index';

interface IUnresolvedInput {
  /** Hard cap on returned file groups. Default 200. */
  limit?: number;
}

/**
 * Read-only MCP mirror of `shrk graph unresolved`. Returns every
 * `unresolved:<spec>` ImportsFile edge grouped by source file.
 * Sorted by unresolved-count desc so the worst offenders surface first.
 *
 * Same safety contract as the other graph tools: structured
 * `graph-missing` error when the index isn't built yet.
 */
export const getGraphUnresolvedTool: IToolDefinition = {
  name: 'get_graph_unresolved',
  description:
    'List every unresolved import in the code graph, grouped by source file. Sorted by unresolved-count desc. Pass `format:"table"` for a token-efficient columnar encoding of the file list. Read-only.',
  cliCommand: 'graph unresolved',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IUnresolvedInput;
    const limit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? args.limit
        : 200;
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
    const snap = store.loadSnapshot();
    type Group = { from: string; path?: string; specifiers: Set<string> };
    const groups = new Map<string, Group>();
    for (const e of snap.edges.values()) {
      if (e.kind !== EdgeKind.ImportsFile) continue;
      if (!e.to.startsWith('unresolved:')) continue;
      const fromNode: INode | undefined = snap.nodes.get(e.from);
      const spec = e.to.slice('unresolved:'.length);
      const existing = groups.get(e.from);
      if (existing) {
        existing.specifiers.add(spec);
      } else {
        groups.set(e.from, {
          from: e.from,
          ...(fromNode?.path ? { path: fromNode.path } : {}),
          specifiers: new Set([spec]),
        });
      }
    }
    const list = [...groups.values()]
      .map((g) => ({
        path: g.path ?? g.from.replace(/^file:/, ''),
        unresolved: [...g.specifiers].sort(),
      }))
      .sort((a, b) => {
        if (b.unresolved.length !== a.unresolved.length) {
          return b.unresolved.length - a.unresolved.length;
        }
        return a.path.localeCompare(b.path);
      });
    const totalEdges = list.reduce((n, g) => n + g.unresolved.length, 0);
    const data = {
      schema: 'sharkcraft.graph-unresolved/v1',
      totalEdges,
      totalFiles: list.length,
      truncated: list.length > limit,
      files: list.slice(0, limit),
    };
    // `format:"table"` columnar-encodes the top-level `files` array (one row per
    // source file); scalars (schema/totalEdges/…) and each row's inner
    // `unresolved` string array are left untouched by the helper.
    return { data: formatObjectArrays(data, input) };
  },
};
