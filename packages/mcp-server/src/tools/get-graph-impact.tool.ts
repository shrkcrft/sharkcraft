import { GraphQueryApi, GraphStore, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

const NEXT = 'shrk graph index';

interface IImpactInput {
  target?: string;
  maxDepth?: number;
  limit?: number;
}

export const getGraphImpactTool: IToolDefinition = {
  name: 'get_graph_impact',
  description:
    'Compute reverse closure (importers + transitive) for a file or symbol. Returns direct and transitive dependents capped by limit. Read-only.',
  cliCommand: 'graph impact',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      maxDepth: { type: 'number' },
      limit: { type: 'number' },
      ...FORMAT_INPUT_PROPERTY,
    },
    required: ['target'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IImpactInput;
    const target = (args.target ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'target is required' },
      };
    }
    const maxDepth = clamp(args.maxDepth ?? 5, 1, 10);
    const limit = clamp(args.limit ?? 200, 1, 2000);
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
    const closure = reverseClosure(api, anchor.id, maxDepth, limit);
    const direct = closure.layer[1] ?? [];
    const transitive = closure.all.filter((id) => id !== anchor.id && !direct.includes(id));
    const data = {
      schema: 'sharkcraft.graph-impact/v1',
      anchor: summarise(anchor),
      maxDepth,
      limit,
      truncated: closure.truncated,
      directDependents: direct.map((id) => summarise(api.neighbours(id)!.node)),
      transitiveDependents: transitive
        .slice(0, limit)
        .map((id) => summarise(api.neighbours(id)!.node)),
      totalReached: closure.all.length - 1,
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

function reverseClosure(
  api: GraphQueryApi,
  startId: string,
  maxDepth: number,
  limit: number,
): { all: string[]; layer: Record<number, string[]>; truncated: boolean } {
  const seen = new Set<string>([startId]);
  const layer: Record<number, string[]> = {};
  let frontier: string[] = [startId];
  let depth = 1;
  let truncated = false;
  while (depth <= maxDepth && frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const imp of api.importersOf(id)) {
        if (seen.has(imp.id)) continue;
        seen.add(imp.id);
        next.push(imp.id);
        if (seen.size - 1 >= limit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (next.length > 0) layer[depth] = next;
    frontier = next;
    depth += 1;
    if (truncated) break;
  }
  return { all: [...seen], layer, truncated };
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
