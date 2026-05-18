import { listSmokeScenarios } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getReleaseSmokeReportTool: IToolDefinition = {
  name: 'get_release_smoke_report',
  description:
    'Return the static smoke plan for a given scope. MCP cannot execute commands, so this tool returns the planned steps and expected artifacts only. Use `shrk release smoke --scenario <id>` from the CLI to actually run them.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler() {
    return {
      data: {
        schema: 'sharkcraft.release-smoke-plan/v1',
        scenarios: listSmokeScenarios(),
        nextCommand: 'shrk release smoke --scenario all',
        note:
          'MCP returns the plan only. The CLI executes the scenarios and writes results into temp fixtures.',
      },
    };
  },
};
