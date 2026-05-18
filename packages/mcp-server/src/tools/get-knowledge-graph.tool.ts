import { buildKnowledgeGraph } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getKnowledgeGraphTool: IToolDefinition = {
  name: 'get_knowledge_graph',
  description:
    'Return the full SharkCraft knowledge graph: nodes (knowledge/rules/paths/templates/pipelines/presets/packs/boundaries) and edges (related-template, preset-references, pipeline-step-references, …). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const graph = buildKnowledgeGraph(ctx.inspection);
    return { data: { nodes: graph.nodes, edges: graph.edges } };
  },
};
