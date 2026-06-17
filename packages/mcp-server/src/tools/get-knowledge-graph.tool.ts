import { buildKnowledgeGraph } from '@shrkcrft/inspector';
import { compactArrayToColumnar, estimateTokens } from '@shrkcrft/compress';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { wantsTable } from '../server/columnar-format.ts';
import { fitArrayToBudget } from '../server/fit-array-to-budget.ts';

/**
 * The knowledge graph is the largest single payload shrk emits — hundreds of
 * homogeneous node/edge objects. `format:"table"` returns the same data in
 * columnar form (schema hoisted once, keys deduped) which is still valid JSON
 * but a fraction of the tokens. `format:"json"` (default) keeps the explicit
 * node/edge arrays for back-compat.
 */
export const getKnowledgeGraphTool: IToolDefinition = {
  name: 'get_knowledge_graph',
  description:
    'Return the full SharkCraft knowledge graph: nodes (knowledge/rules/paths/templates/pipelines/presets/packs/boundaries) and edges (related-template, preset-references, pipeline-step-references, …). Pass `format:"table"` for a token-efficient columnar encoding (still valid JSON) — recommended for large graphs. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'table'],
        description:
          'json (default): explicit node/edge object arrays. table: columnar encoding (schema hoisted, keys deduped) — fewer tokens for large graphs.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description:
          'Token budget for the table. When set and the lossless columnar form still exceeds it, falls back to the lossy SmartCrusher row-sampler (representative rows kept; full original cached — retrieve via the returned ccrKey).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const graph = buildKnowledgeGraph(ctx.inspection);
    const asTable = wantsTable(input);
    const maxTokens =
      typeof input.maxTokens === 'number' && input.maxTokens > 0 ? Math.floor(input.maxTokens) : undefined;
    const nodesTable = asTable ? compactArrayToColumnar(graph.nodes) : null;
    const edgesTable = asTable ? compactArrayToColumnar(graph.edges) : null;
    // Only advertise `table` when at least one array actually compacted — a tiny
    // graph (e.g. edges:[]) stays the plain JSON form rather than a mislabelled
    // "table" whose fields are bare arrays.
    if (nodesTable || edgesTable) {
      // P5.2: with no budget, keep the lossless columnar form (unchanged). With
      // a budget, fit each array — sampling + CCR when it's still over.
      const nodes = maxTokens
        ? fitArrayToBudget(graph.nodes, maxTokens, ctx.ccrStore)
        : { value: nodesTable ?? graph.nodes };
      const edges = maxTokens
        ? fitArrayToBudget(graph.edges, maxTokens, ctx.ccrStore)
        : { value: edgesTable ?? graph.edges };
      const ccrKeys = [nodes.ccrKey, edges.ccrKey].filter((k): k is string => Boolean(k));
      const before = estimateTokens(JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
      const after = estimateTokens(JSON.stringify({ nodes: nodes.value, edges: edges.value }));
      return {
        data: {
          format: 'table',
          legend:
            'Columnar tables: _table.cols are column names; each _table.rows[i] is one record aligned to cols; _table.absent lists [row,col] positions whose key was absent. Reconstruct objects by zipping cols with each row, skipping absent positions. If a column appears in _table.dict, its row cells are integer indices into dict[<col>] (deref to the real value). A field may be a plain array when it was too small to compact. A _table.sample block means rows were dropped to fit a budget — retrieve the full original via ccrKey.',
          nodes: nodes.value,
          edges: edges.value,
          tokenEstimate: { before, after, saved: Math.max(0, before - after) },
          ...(ccrKeys.length > 0
            ? { ccrKeys, retrieveWith: `retrieve_original { "key": "${ccrKeys[0]}" }` }
            : {}),
        },
      };
    }
    // Default (and tiny-graph) path: the original bare `{ nodes, edges }` shape,
    // byte-identical to pre-compression clients (no extra `format` key).
    return { data: { nodes: graph.nodes, edges: graph.edges } };
  },
};
