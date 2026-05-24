import { GraphQueryApi, GraphStore, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk graph index';

interface ICallersInput {
  symbol?: string;
  mode?: 'call' | 'reference';
}

export const getGraphCallersTool: IToolDefinition = {
  name: 'get_graph_callers',
  description:
    'Return files that call or reference the given symbol. Mode "call" → calls-symbol edges; mode "reference" → both references-symbol and calls-symbol. Read-only.',
  cliCommand: 'graph callers',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string' },
      mode: { type: 'string', enum: ['call', 'reference'] },
    },
    required: ['symbol'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as ICallersInput;
    const target = (args.symbol ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'symbol is required' },
      };
    }
    const mode = args.mode ?? 'call';
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
    const api = GraphQueryApi.fromStore(ctx.inspection.projectRoot);
    const sym = resolveSymbol(api, target);
    if (!sym) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No symbol matched "${target}".`,
          details: { target },
        },
      };
    }
    const hits = mode === 'reference' ? api.referencesOf(sym.id) : api.callersOf(sym.id);
    return {
      data: {
        schema: 'sharkcraft.graph-callers/v1',
        symbol: summarise(sym),
        mode,
        total: hits.length,
        callers: hits.slice(0, 200).map(summarise),
      },
    };
  },
};

function resolveSymbol(api: GraphQueryApi, target: string): INode | undefined {
  if (target.startsWith('symbol:')) return api.neighbours(target)?.node;
  const syms = api.findSymbol(target, { exact: true, limit: 5 });
  if (syms.length === 0) return undefined;
  if (syms.length === 1) return syms[0];
  const exported = syms.find((s) => (s.data?.['isExported'] ?? false) === true);
  return exported ?? syms[0];
}

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
