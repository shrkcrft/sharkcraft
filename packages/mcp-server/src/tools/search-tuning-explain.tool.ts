import { explainSearchTuning, loadSearchTuning } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const explainSearchTuningTool: IToolDefinition = {
  name: 'explain_search_tuning',
  description:
    'Return a structured explainer for how tuning would influence a given query. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, topN: { type: 'number' } },
  },
  async handler(input, ctx) {
    const query = String(input['query'] ?? '');
    const topN = typeof input['topN'] === 'number' ? (input['topN'] as number) : undefined;
    await loadSearchTuning(ctx.inspection);
    const report = await explainSearchTuning(
      ctx.inspection,
      query,
      topN ? { topN } : {},
    );
    return { data: report };
  },
};
