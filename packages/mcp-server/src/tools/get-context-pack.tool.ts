import { planContext } from '@shrkcrft/context-planner';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  task?: string;
  budgetTokens?: number;
  hintedFiles?: readonly string[];
  hintedPackages?: readonly string[];
  maxFiles?: number;
}

export const getContextPackTool: IToolDefinition = {
  name: 'get_context_pack',
  description:
    'Produce a deterministic, token-budgeted context pack (`sharkcraft.context-pack/v1`) for an AI coding agent: ranked relevant files, applicable rules, paths, templates, likely tests, surfaced risks, do-not-touch zones. Read-only.',
  cliCommand: 'plan-context',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      budgetTokens: { type: 'number' },
      hintedFiles: { type: 'array', items: { type: 'string' } },
      hintedPackages: { type: 'array', items: { type: 'string' } },
      maxFiles: { type: 'number' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const task = (args.task ?? '').trim();
    if (!task) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'task is required' },
      };
    }
    const pack = planContext({
      projectRoot: ctx.inspection.projectRoot,
      task,
      budgetTokens: clamp(args.budgetTokens ?? 8000, 500, 64000),
      maxFiles: clamp(args.maxFiles ?? 30, 1, 200),
      ...(args.hintedFiles ? { hintedFiles: args.hintedFiles } : {}),
      ...(args.hintedPackages ? { hintedPackages: args.hintedPackages } : {}),
    });
    return { data: pack };
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
