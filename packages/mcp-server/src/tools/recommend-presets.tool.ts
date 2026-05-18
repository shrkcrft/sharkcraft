import { recommendPresets } from '@shrkcrft/presets';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const recommendPresetsTool: IToolDefinition = {
  name: 'recommend_presets',
  description:
    'Recommend presets based on the detected project profile (e.g. has-bun, has-typescript, is-monorepo). Returns ranked preset ids with confidence + reasons.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', minimum: 1, maximum: 20 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const limit = Number((input as { limit?: unknown }).limit ?? 5);
    const recs = recommendPresets(ctx.inspection.presetRegistry.list(), {
      profiles: ctx.inspection.workspace.profiles,
      limit,
    });
    return {
      data: {
        detectedProfiles: ctx.inspection.workspace.profiles,
        recommendations: recs.map((r) => ({
          presetId: r.preset.id,
          title: r.preset.title,
          score: r.score,
          confidence: r.confidence,
          reasons: r.reasons,
        })),
      },
    };
  },
};
