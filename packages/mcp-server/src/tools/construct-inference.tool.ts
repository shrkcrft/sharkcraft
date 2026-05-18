import {
  InferredConstructConfidence,
  inferConstructs,
  loadConstructs,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const inferConstructsPreviewTool: IToolDefinition = {
  name: 'infer_constructs_preview',
  description:
    'Infer construct candidates from files, conventions, and the import graph. Read-only — no drafts are written. Use `shrk constructs infer --write-drafts` to materialise them.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      minConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const minConf =
      typeof input['minConfidence'] === 'string'
        ? (input['minConfidence'] as InferredConstructConfidence)
        : undefined;
    await loadConstructs(ctx.inspection);
    const result = await inferConstructs(ctx.inspection, {
      ...(typeof input['type'] === 'string' ? { type: input['type'] as string } : {}),
      ...(minConf ? { minConfidence: minConf } : {}),
      ...(typeof input['limit'] === 'number' ? { limit: input['limit'] as number } : {}),
    });
    return { data: result };
  },
};
