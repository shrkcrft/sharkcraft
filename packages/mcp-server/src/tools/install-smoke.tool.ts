import { getInstallSmokePlan } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getInstallSmokeReportTool: IToolDefinition = {
  name: 'get_install_smoke_report',
  description:
    'Return the install-smoke plan (steps the CLI will run to verify the installed surface). MCP returns the plan only — the CLI runs the steps.',
  inputSchema: { type: 'object', additionalProperties: false },
  handler() {
    return {
      data: {
        schema: 'sharkcraft.install-smoke-plan/v1',
        plan: getInstallSmokePlan(),
        nextCommand: 'shrk install smoke',
      },
    };
  },
};
