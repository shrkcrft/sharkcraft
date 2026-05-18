import { runPackReleaseCheck } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackReleaseCheckTool: IToolDefinition = {
  name: 'get_pack_release_check',
  description: 'Run a deterministic release-readiness check on a pack path. Read-only.',
  inputSchema: {
    type: 'object',
    required: ['packPath'],
    properties: { packPath: { type: 'string' } },
  },
  async handler(input) {
    const packPath = String(input['packPath'] ?? '');
    if (!packPath) return { error: { code: 'missing-arg', message: 'packPath is required' } };
    const result = await runPackReleaseCheck(packPath);
    return { data: result };
  },
};
