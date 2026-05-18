import { scanImports, summarizeImports } from '@shrkcrft/boundaries';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getImportGraphSummaryTool: IToolDefinition = {
  name: 'get_import_graph_summary',
  description:
    'Scan the project and return import-graph summary stats (files scanned, internal/external counts, top external specifiers, warnings). Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const scan = scanImports({ projectRoot: ctx.inspection.projectRoot });
    return { data: summarizeImports(scan) };
  },
};
