import { analyzeImportGraph } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getImportGraphAnalysisTool: IToolDefinition = {
  name: 'get_import_graph_analysis',
  description: 'Detailed import-graph analysis (cycles, fan-in/out, orphans). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    return { data: analyzeImportGraph(ctx.cwd) };
  },
};
