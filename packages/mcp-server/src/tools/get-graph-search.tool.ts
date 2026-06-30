import { GraphQueryApi, GraphStore, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { dropDeleted, graphResultStaleness } from './graph-staleness.ts';

const NEXT = 'shrk graph index';

interface ISearchInput {
  query?: string;
  kind?: 'file' | 'symbol' | 'package';
  limit?: number;
  exact?: boolean;
}

export const getGraphSearchTool: IToolDefinition = {
  name: 'get_graph_search',
  description:
    'Search the code graph by file path, symbol name, or package name. Returns ranked node summaries. Read-only.',
  cliCommand: 'graph search',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kind: { type: 'string', enum: ['file', 'symbol', 'package'] },
      limit: { type: 'number' },
      exact: { type: 'boolean' },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as ISearchInput;
    const query = (args.query ?? '').trim();
    if (!query) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'query is required' },
      };
    }
    const limit = Math.max(1, Math.min(200, args.limit ?? 20));
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
    const exact = args.exact ?? false;
    // The shared query method returns the display page AND the TRUE pre-slice
    // match count, so `total`/`truncated` stay honest (the old `Math.min(len,
    // limit)` could NEVER exceed `limit`, hiding 285 matches behind `total: 20`).
    const { matches, total } = api.searchNodes(query, {
      ...(args.kind ? { kind: args.kind } : {}),
      limit,
      exact,
    });
    // Prune deleted result files + flag modified ones (parity with
    // get_graph_callers): a stale index must never serve a hit for a file the
    // agent already deleted. `total` is reduced by the deletions we observed on
    // the page so it never over-counts dead files.
    const summarised = matches.map(summarise);
    const fresh = graphResultStaleness(api, ctx.inspection.projectRoot, summarised.map((m) => m.path));
    const live = dropDeleted(summarised, fresh.deletedSet);
    const adjustedTotal = total - (summarised.length - live.length);
    const data = {
      schema: 'sharkcraft.graph-search/v1',
      query,
      kind: args.kind ?? 'any',
      total: adjustedTotal,
      truncated: adjustedTotal > limit,
      matches: live,
      ...(fresh.field ?? {}),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function summarise(n: INode): {
  id: string;
  kind: string;
  label: string;
  path?: string;
  line?: number;
} {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.path ? { path: n.path } : {}),
    ...(n.line ? { line: n.line } : {}),
  };
}
