import { GraphQueryApi, GraphStore, loadGraphApiCached, type INode } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';

const NEXT = 'shrk graph index';

interface IHubsInput {
  limit?: number;
  /** Optional path prefix to scope hubs to one subsystem (e.g. `packages/inspector`). */
  path?: string;
}

export const getGraphHubsTool: IToolDefinition = {
  name: 'get_graph_hubs',
  description:
    'The most-depended-on code: symbols ranked by how many DISTINCT files reference them, files by how many import them. The "load-bearing code" to change most carefully (biggest blast radius) and understand first when onboarding — the companion to get_graph_impact. Pass `path` (e.g. "packages/foo") to scope to one subsystem. Read-only; needs `shrk graph index`.',
  cliCommand: 'graph hubs',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number' },
      path: { type: 'string' },
      ...FORMAT_INPUT_PROPERTY,
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IHubsInput;
    const limit = clampLimit(args.limit);
    const projectRoot = ctx.inspection.projectRoot;
    const store = new GraphStore(projectRoot);
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
    const api = loadGraphApiCached(projectRoot) ?? GraphQueryApi.fromStore(projectRoot);
    const pathScope = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined;
    const hubs = api.topHubs(limit, pathScope);
    const row = (h: { node: INode; inDegree: number }): Record<string, unknown> => ({
      ...summarise(h.node),
      inDegree: h.inDegree,
    });
    const data = {
      schema: 'sharkcraft.graph-hubs/v1',
      ...(pathScope ? { path: pathScope } : {}),
      symbols: hubs.symbols.map(row),
      files: hubs.files.map(row),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function clampLimit(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15;
  return Math.max(1, Math.min(100, Math.floor(raw)));
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
