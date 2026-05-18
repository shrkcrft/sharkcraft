/**
 * Read-only language runner policy preview.
 */
import { getLanguageRunnerPolicy } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getLanguageRunnerPolicyTool: IToolDefinition = {
  name: 'get_language_runner_policy',
  description:
    'Show the language runner policy (allowlist + denylist + built-in deny patterns). Read-only.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  handler(_input, ctx) {
    const policy = getLanguageRunnerPolicy(ctx.cwd);
    return {
      text: `Next: \`shrk languages runner config\` (CLI is the only write path).`,
      data: policy,
    };
  },
};
