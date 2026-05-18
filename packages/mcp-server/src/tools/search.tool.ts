import {
  buildSearchIndex,
  loadConstructs,
  loadPlaybooks,
  searchIndex,
  SearchKind,
  SearchSource,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const searchAllTool: IToolDefinition = {
  name: 'search_all',
  description:
    'Unified, deterministic search across knowledge, rules, paths, templates, pipelines, presets, packs, boundaries, docs, sessions, bundles, constructs, and playbooks. No AI / embeddings — pure ranking. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      kinds: { type: 'array', items: { type: 'string' } },
      sources: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number' },
      explain: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const query = typeof input['query'] === 'string' ? (input['query'] as string) : '';
    const limit = typeof input['limit'] === 'number' ? (input['limit'] as number) : 30;
    const explain = Boolean(input['explain']);
    const rawKinds = Array.isArray(input['kinds']) ? (input['kinds'] as string[]) : [];
    const rawSources = Array.isArray(input['sources']) ? (input['sources'] as string[]) : [];
    const validKinds = new Set(Object.values(SearchKind));
    const validSources = new Set(Object.values(SearchSource));
    const kinds = rawKinds.filter((k) => validKinds.has(k as SearchKind)) as SearchKind[];
    const sources = rawSources.filter((s) => validSources.has(s as SearchSource)) as SearchSource[];
    await loadConstructs(ctx.inspection);
    await loadPlaybooks(ctx.inspection);
    const index = buildSearchIndex(ctx.inspection);
    const opts: Parameters<typeof searchIndex>[1] = { query, limit, explain };
    if (kinds.length > 0) opts.kinds = kinds;
    if (sources.length > 0) opts.sources = sources;
    const result = searchIndex(index, opts);
    return {
      data: {
        query: result.query,
        total: result.total,
        truncated: result.truncated,
        hits: result.hits,
      },
    };
  },
};
