import {
  buildStartHereReport,
  buildPrimaryCommandsReport,
  type StartHereFlow,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getStartHereTool: IToolDefinition = {
  name: 'get_start_here',
  description:
    'Return the SharkCraft start-here flow list (30-second explanation + 5 primary flows + safety pledge). Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      flow: {
        type: 'string',
        enum: ['onboard', 'brief', 'dev', 'review', 'governance', 'packs', 'release'],
      },
    },
    additionalProperties: false,
  },
  handler(input) {
    const flow = typeof input['flow'] === 'string' ? (input['flow'] as StartHereFlow) : null;
    return { data: buildStartHereReport(flow) };
  },
};

export const getPrimaryCommandsTool: IToolDefinition = {
  name: 'get_primary_commands',
  description: 'Return the curated primary SharkCraft command list. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false },
  handler() {
    return { data: buildPrimaryCommandsReport() };
  },
};
