import { replayBundle } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const replayBundleApplyTool: IToolDefinition = {
  name: 'replay_bundle_apply',
  description: 'Replay a bundle apply-audit.log and detect tampering / drift. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['bundleId'],
    properties: {
      bundleId: { type: 'string' },
      strict: { type: 'boolean' },
    },
  },
  handler(input, ctx) {
    const bundleId = String(input['bundleId'] ?? '');
    const strict = Boolean(input['strict']);
    const data = replayBundle(ctx.inspection.projectRoot, bundleId, { strict });
    return { data };
  },
};
