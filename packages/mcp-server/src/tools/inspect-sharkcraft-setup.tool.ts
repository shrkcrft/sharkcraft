import type { IToolDefinition } from '../server/tool-definition.ts';
import { doctorVerdict, runDoctor } from '@shrkcrft/inspector';

export const inspectSharkcraftSetupTool: IToolDefinition = {
  name: 'inspect_sharkcraft_setup',
  description: 'Validate the SharkCraft setup in the current repo (config, knowledge, templates).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const result = runDoctor(ctx.inspection);
    // `passed` is errors-only. `verdict` / `ready` come from THE doctor
    // settlement (`doctorVerdict`) that `shrk doctor`, `shrk check` and the
    // dashboard read, so a setup the doctor could not fully verify (a compiled
    // pack build with no build record) is `not-verified` here too — never
    // ready. Additive keys; the input is unchanged.
    const settled = doctorVerdict(result);
    return {
      data: {
        ...result,
        verdict: settled.verdict,
        ready: settled.ready,
        ...(settled.shortfalls.length > 0 ? { shortfalls: settled.shortfalls } : {}),
      },
    };
  },
};
