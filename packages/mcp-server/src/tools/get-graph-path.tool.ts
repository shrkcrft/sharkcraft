import {
  EdgeKind,
  GraphQueryApi,
  GraphStore,
  loadGraphApiCached,
  NodeKind,
  type INode,
} from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { callGraphLanguageNote, graphResultStaleness } from './graph-staleness.ts';

const NEXT = 'shrk graph index';

interface IPathInput {
  from?: string;
  to?: string;
  maxDepth?: number;
}

export const getGraphPathTool: IToolDefinition = {
  name: 'get_graph_path',
  description:
    'Is code A actually wired to code B? Returns the shortest directed CODE path (import/call/reference/declare/re-export/extends/implements edges) from `from` to `to`, hop by hop with edge kind and call-site line — the deterministic answer to "is X wired to Y" that grep cannot give. If A does not reach B it also checks B→A and reports the direction. Each endpoint is a file path or a symbol name. Read-only; needs `shrk graph index`.',
  cliCommand: 'graph path',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string' },
      to: { type: 'string' },
      maxDepth: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IPathInput;
    const fromArg = (args.from ?? '').trim();
    const toArg = (args.to ?? '').trim();
    if (!fromArg || !toArg) {
      return { isError: true, error: { code: 'invalid-input', message: 'from and to are required' } };
    }
    const maxDepth = clampDepth(args.maxDepth);
    const cwd = ctx.inspection.projectRoot;
    const store = new GraphStore(cwd);
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
    const api = loadGraphApiCached(cwd) ?? GraphQueryApi.fromStore(cwd);
    const from = resolveAnchor(api, fromArg);
    const to = resolveAnchor(api, toArg);
    if (!from || !to) {
      const missing = !from ? fromArg : toArg;
      return {
        isError: true,
        error: { code: 'not-found', message: `No graph node matched "${missing}".`, details: { target: missing } },
      };
    }
    // A symbol has no OUTGOING code edges (references are recorded file→symbol),
    // so trace from its declaring file. The target may stay a symbol.
    const fromStart = bfsStartNode(api, from);
    const toStart = bfsStartNode(api, to);
    const forward = api.pathBetween(fromStart.id, to.id, { maxDepth });
    const reverse = forward.found ? null : api.pathBetween(toStart.id, from.id, { maxDepth });
    const direction: 'forward' | 'reverse' | 'none' = forward.found
      ? 'forward'
      : reverse?.found
        ? 'reverse'
        : 'none';
    const chosen = forward.found ? forward : reverse?.found ? reverse : forward;
    const startEndpoint = direction === 'reverse' ? to : from;
    const startFile = direction === 'reverse' ? toStart : fromStart;
    const startNote =
      direction !== 'none' && startFile.id !== startEndpoint.id && startEndpoint.kind === NodeKind.Symbol
        ? `\`${startEndpoint.label}\` is declared in ${startFile.path ?? startFile.id}; path traced from that file (per-symbol out-edges are not tracked).`
        : undefined;
    const hops = chosen.hops.map((h) => ({
      from: h.from.path ?? h.from.id,
      to: h.to.path ?? h.to.id,
      kind: h.kind,
      label: h.to.label,
      ...(h.line ? { line: h.line } : {}),
    }));
    const fresh = graphResultStaleness(api, cwd, [
      from.path,
      to.path,
      ...chosen.hops.map((h) => h.from.path),
      ...chosen.hops.map((h) => h.to.path),
    ]);
    // A no-path answer between non-TS endpoints may just be missing call edges.
    const langNote =
      direction === 'none' ? callGraphLanguageNote(api, from) ?? callGraphLanguageNote(api, to) : undefined;
    const data = {
      schema: 'sharkcraft.graph-path/v1',
      from: summarise(from),
      to: summarise(to),
      found: direction !== 'none',
      direction,
      ...(direction !== 'none' && startFile.id !== startEndpoint.id ? { tracedFrom: summarise(startFile) } : {}),
      hops,
      hopCount: hops.length,
      explored: forward.found ? forward.explored : reverse?.explored ?? forward.explored,
      ...(direction === 'none' && chosen.reason ? { reason: chosen.reason } : {}),
      ...(startNote ?? langNote ? { note: startNote ?? langNote } : {}),
      ...(fresh.field ?? {}),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function clampDepth(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 16;
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

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

/** A file is its own BFS start; a symbol resolves to its declaring file. */
function bfsStartNode(api: GraphQueryApi, node: INode): INode {
  if (node.kind !== NodeKind.Symbol) return node;
  const neighbours = api.neighbours(node.id);
  if (neighbours) {
    for (const incoming of neighbours.in) {
      if (incoming.edge.kind !== EdgeKind.DeclaresSymbol) continue;
      if ('resolved' in incoming.source) continue;
      if (incoming.source.kind === NodeKind.File) return incoming.source;
    }
  }
  return (node.path ? api.findFile(node.path) : undefined) ?? node;
}

function summarise(n: INode): { id: string; kind: string; label: string; path?: string; line?: number } {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.path ? { path: n.path } : {}),
    ...(n.line ? { line: n.line } : {}),
  };
}
