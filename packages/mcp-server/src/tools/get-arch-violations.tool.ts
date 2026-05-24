import { runArchCheck } from '@shrkcrft/architecture-guard';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  enable?: {
    publicApi?: boolean;
    barrels?: boolean;
    cycles?: boolean;
    contract?: boolean;
  };
}

export const getArchViolationsTool: IToolDefinition = {
  name: 'get_arch_violations',
  description:
    'Run the architecture-guard checks (public-API misuse, barrel risks, cycle severity) against the code graph. Reads `sharkcraft/arch.ts` if present for project-specific contracts. Read-only.',
  cliCommand: 'arch check',
  inputSchema: {
    type: 'object',
    properties: {
      enable: {
        type: 'object',
        properties: {
          publicApi: { type: 'boolean' },
          barrels: { type: 'boolean' },
          cycles: { type: 'boolean' },
          contract: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const report = runArchCheck({
      projectRoot: ctx.inspection.projectRoot,
      ...(args.enable ? { enable: args.enable } : {}),
    });
    return { data: report };
  },
};
