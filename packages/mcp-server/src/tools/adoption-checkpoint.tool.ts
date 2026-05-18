import {
  buildConstructAdoptionDiff,
  buildOnboardAdoptionDiff,
  evaluateAdoptionCheckpoint,
  hashDiffBody,
  loadConstructs,
  readAdoptionCheckpoint,
  renderConstructAdoptionDiff,
  renderOnboardAdoptionDiff,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getAdoptionCheckpointStatusTool: IToolDefinition = {
  name: 'get_adoption_checkpoint_status',
  description:
    'Read the adoption checkpoint (onboard or construct) and report whether targets/drafts/diff hash still match. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['onboard', 'construct'] },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const kindRaw = typeof input['kind'] === 'string' ? (input['kind'] as 'onboard' | 'construct') : 'onboard';
    if (kindRaw !== 'onboard' && kindRaw !== 'construct') {
      return {
        isError: true,
        text: `Unknown kind "${kindRaw}". Use onboard|construct.`,
        error: { code: 'invalid-kind', message: `Unknown kind "${kindRaw}".` },
      };
    }
    const read = readAdoptionCheckpoint(ctx.cwd, kindRaw);
    let evaluation = null;
    if (read.checkpoint) {
      if (kindRaw === 'construct') {
        await loadConstructs(ctx.inspection);
        const diff = await buildConstructAdoptionDiff(ctx.inspection);
        const canonical = renderConstructAdoptionDiff(diff, 'json');
        evaluation = evaluateAdoptionCheckpoint(ctx.cwd, read.checkpoint, hashDiffBody(canonical));
      } else {
        const diff = buildOnboardAdoptionDiff(ctx.inspection);
        const canonical = renderOnboardAdoptionDiff(diff, 'json');
        evaluation = evaluateAdoptionCheckpoint(ctx.cwd, read.checkpoint, hashDiffBody(canonical));
      }
    }
    return {
      data: {
        kind: kindRaw,
        path: read.path,
        exists: read.exists,
        checkpoint: read.checkpoint,
        ...(evaluation
          ? { status: evaluation.status, reasons: evaluation.reasons, changedTargets: evaluation.changedTargets, changedDrafts: evaluation.changedDrafts }
          : { status: 'missing', reasons: ['no checkpoint on disk yet'] }),
      },
    };
  },
};
