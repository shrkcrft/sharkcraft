import {
  GraphQueryApi,
  GraphStore,
  NodeKind,
  type INode,
} from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

const NEXT = 'shrk graph index';

interface IContextInput {
  target?: string;
}

export const getGraphContextTool: IToolDefinition = {
  name: 'get_graph_context',
  description:
    'Return graph context for a file or symbol: declared symbols, files this imports, files that import it. Read-only.',
  cliCommand: 'graph context',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' }, ...FORMAT_INPUT_PROPERTY },
    required: ['target'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IContextInput;
    const target = (args.target ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'target is required' },
      };
    }
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
    const anchor = resolveAnchor(api, target);
    if (!anchor) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No graph node matched "${target}".`,
          details: { target },
        },
      };
    }
    const neighbours = api.neighbours(anchor.id)!;
    const symbols = anchor.kind === NodeKind.File ? api.symbolsIn(anchor.id) : [];
    const data = {
      schema: 'sharkcraft.graph-context/v1',
      anchor: summarise(anchor),
      importsFrom: neighbours.out
        .filter((o) => o.edge.kind === 'imports-file')
        .slice(0, 50)
        .map((o) => ('resolved' in o.target
          ? { id: o.target.id, resolved: false }
          : { ...summarise(o.target), resolved: true })),
      importedBy: neighbours.in
        .filter((i) => i.edge.kind === 'imports-file')
        .slice(0, 50)
        .map((i) => ('resolved' in i.source
          ? { id: i.source.id, resolved: false }
          : { ...summarise(i.source), resolved: true })),
      symbols: symbols.slice(0, 50).map(summarise),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function resolveAnchor(api: GraphQueryApi, target: string): INode | undefined {
  const direct = api.neighbours(target);
  if (direct) return direct.node;
  if (target.startsWith('file:') || target.startsWith('symbol:') || target.startsWith('package:')) {
    return undefined;
  }
  const f = api.findFile(target);
  if (f) return f;
  const syms = api.findSymbol(target, { exact: true, limit: 1 });
  if (syms.length > 0) return syms[0];
  return undefined;
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
