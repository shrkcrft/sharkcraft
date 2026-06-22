import { GraphQueryApi, GraphStore, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

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
    const matches: INode[] = [];
    if (!args.kind || args.kind === 'file') {
      const f = api.findFile(query);
      if (f) matches.push(f);
      // Fuzzy fallback (mirrors the CLI): substring match on path/basename so a
      // bare name like `Foo` finds `packages/x/Foo.ts` without the full path —
      // otherwise the MCP returned an empty list where the CLI found the file.
      if (!exact && matches.length < limit) {
        const q = query.toLowerCase();
        const seen = new Set(matches.map((n) => n.id));
        for (const node of api.allFiles()) {
          if (seen.has(node.id)) continue;
          const p = node.path?.toLowerCase() ?? '';
          const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
          if (base.includes(q) || p.includes(q)) {
            matches.push(node);
            seen.add(node.id);
            if (matches.length >= limit) break;
          }
        }
      }
    }
    if (!args.kind || args.kind === 'symbol') {
      for (const s of api.findSymbol(query, { exact, limit })) matches.push(s);
    }
    if (!args.kind || args.kind === 'package') {
      const p = api.neighbours(`package:${query}`);
      if (p) matches.push(p.node);
    }
    const data = {
      schema: 'sharkcraft.graph-search/v1',
      query,
      kind: args.kind ?? 'any',
      total: Math.min(matches.length, limit),
      matches: matches.slice(0, limit).map(summarise),
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
