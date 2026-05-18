import { buildKnowledgeGraph, findGraphPath } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const graphWhyTool: IToolDefinition = {
  name: 'graph_why',
  description:
    'Find the shortest path between two knowledge-graph nodes. Returns the node sequence + the edge relation/reason that links each step. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      fromId: { type: 'string' },
      toId: { type: 'string' },
      fromKind: { type: 'string' },
      toKind: { type: 'string' },
    },
    required: ['fromId', 'toId'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const fromId = String((input as { fromId?: unknown }).fromId ?? '');
    const toId = String((input as { toId?: unknown }).toId ?? '');
    const fromKind = (input as { fromKind?: unknown }).fromKind;
    const toKind = (input as { toKind?: unknown }).toKind;
    const graph = buildKnowledgeGraph(ctx.inspection);
    const path = findGraphPath(
      graph,
      typeof fromKind === 'string' ? { kind: fromKind as never, id: fromId } : { id: fromId },
      typeof toKind === 'string' ? { kind: toKind as never, id: toId } : { id: toId },
    );
    return { data: path };
  },
};
