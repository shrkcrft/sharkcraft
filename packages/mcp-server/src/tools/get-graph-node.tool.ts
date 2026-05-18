import { buildKnowledgeGraph, getGraphNode } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getGraphNodeTool: IToolDefinition = {
  name: 'get_graph_node',
  description:
    'Return one knowledge-graph node with its incoming/outgoing edges. Useful for explaining why a rule/template/pipeline relates to others.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const kind = (input as { kind?: unknown }).kind;
    const graph = buildKnowledgeGraph(ctx.inspection);
    const node = getGraphNode(graph, typeof kind === 'string' ? { kind: kind as never, id } : { id });
    if (!node) return { isError: true, text: `No node for "${id}".` };
    return { data: node };
  },
};
