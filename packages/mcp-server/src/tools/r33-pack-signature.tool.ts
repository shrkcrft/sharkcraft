/**
 * Read-only MCP tool for pack signature freshness.
 */
import { buildPackSignatureStatusReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getPackSignatureStatusTool: IToolDefinition = {
  name: 'get_pack_signature_status',
  description: 'Pack signature freshness across discovered packs. Never fake-signs. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler(_input, ctx) {
    return { data: buildPackSignatureStatusReport(ctx.inspection) };
  },
};
