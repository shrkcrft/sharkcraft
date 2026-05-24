import { runSearch, type StructuralPattern } from '@shrkcrft/structural-search';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  pattern?: unknown;
  limit?: number;
}

export const getStructuralSearchTool: IToolDefinition = {
  name: 'get_structural_search',
  description:
    'Run a declarative AST pattern over the project and return matches. Patterns are JSON of shape `{ kind: "CallExpression" | "ImportDeclaration" | "ClassDeclaration" | ..., ... }`. No executable predicates, no rewrites. Read-only.',
  cliCommand: 'search-structural',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'object' },
      limit: { type: 'number' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const pat = args.pattern as StructuralPattern | undefined;
    if (!pat || typeof pat !== 'object' || !(pat as { kind?: string }).kind) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'pattern.kind is required' },
      };
    }
    const limit = clamp(args.limit ?? 200, 1, 2000);
    const result = runSearch({
      projectRoot: ctx.inspection.projectRoot,
      pattern: pat,
      limit,
    });
    return { data: result };
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
