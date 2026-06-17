import { buildAgentBrief, BriefMode } from '@shrkcrft/inspector';
import { compressMarkdown } from '@shrkcrft/compress';
import type { IToolDefinition } from '../server/tool-definition.ts';

const VALID_MODES = new Set(Object.values(BriefMode));

export const createAgentBriefTool: IToolDefinition = {
  name: 'create_agent_brief',
  description:
    'Render a single-document Markdown / JSON brief for an AI agent before it starts work. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      mode: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
      bundleId: { type: 'string' },
      sessionId: { type: 'string' },
      maxTokens: { type: 'number' },
      chunked: { type: 'boolean' },
      sectionBudgets: { type: 'object' },
      compact: {
        type: 'boolean',
        description:
          'Run the brief markdown through the deterministic markdown compressor (headers/leads/structure kept, prose thinned). Reversible — the original is cached and a `<<ccr:KEY>>` marker emitted (retrieve_original to recover).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const task = typeof input['task'] === 'string' ? (input['task'] as string) : undefined;
    const modeRaw = typeof input['mode'] === 'string' ? (input['mode'] as string) : undefined;
    const mode = modeRaw && VALID_MODES.has(modeRaw as BriefMode) ? (modeRaw as BriefMode) : undefined;
    const files = Array.isArray(input['files']) ? (input['files'] as string[]) : [];
    const bundleId = typeof input['bundleId'] === 'string' ? (input['bundleId'] as string) : undefined;
    const sessionId = typeof input['sessionId'] === 'string' ? (input['sessionId'] as string) : undefined;
    const maxTokens = typeof input['maxTokens'] === 'number' ? (input['maxTokens'] as number) : undefined;
    const chunked = input['chunked'] === true;
    const sectionBudgets =
      typeof input['sectionBudgets'] === 'object' && input['sectionBudgets'] !== null
        ? (input['sectionBudgets'] as Record<string, number>)
        : undefined;
    const brief = await buildAgentBrief(ctx.inspection, {
      ...(task ? { task } : {}),
      ...(mode ? { mode } : {}),
      files,
      ...(bundleId ? { bundleId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(chunked ? { chunked: true } : {}),
      ...(sectionBudgets ? { sectionBudgets } : {}),
    });
    if (input['compact'] === true) {
      const c = compressMarkdown(brief.markdown, ctx.ccrStore ? { store: ctx.ccrStore } : {});
      return {
        data: {
          ...brief,
          markdown: c.compressed,
          compaction: {
            strategy: c.strategy,
            tokensBefore: c.savings.before,
            tokensAfter: c.savings.after,
            ccrKey: c.ccrKey ?? null,
          },
        },
      };
    }
    return { data: brief };
  },
};
