import { buildRepositoryStats } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IRepositoryStatsInput {
  maxTopFiles?: number;
  language?: string;
}

export const getRepositoryStatsTool: IToolDefinition = {
  name: 'get_repository_stats',
  description:
    'Repository statistics — per-language file counts, lines of code (code/comment/blank), bytes, averages, and the largest files. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      maxTopFiles: {
        type: 'number',
        description: 'How many largest files to include (default 10).',
      },
      language: {
        type: 'string',
        description:
          "Filter to a single language id (e.g. 'typescript', 'java', 'python'). Omit for all languages.",
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const inp = (input ?? {}) as IRepositoryStatsInput;
    const stats = await buildRepositoryStats({
      cwd: ctx.cwd,
      ...(typeof inp.maxTopFiles === 'number' ? { maxTopFiles: inp.maxTopFiles } : {}),
      ...(typeof inp.language === 'string' && inp.language ? { language: inp.language } : {}),
    });
    return { data: stats };
  },
};
