import { loadSearchTuning } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listSearchTuningTool: IToolDefinition = {
  name: 'list_search_tuning',
  description: 'List search-tuning entries contributed by local config and packs. Read-only.',
  inputSchema: { type: 'object', properties: {} },
  async handler(_input, ctx) {
    const { entries, issues } = await loadSearchTuning(ctx.inspection);
    return { data: { entries, issues } };
  },
};
