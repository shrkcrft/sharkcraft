import { planRewrite, type RewriteRecipe, type StructuralPattern } from '@shrkcrft/structural-search';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  pattern?: unknown;
  recipe?: unknown;
  files?: readonly string[];
  perFileLimit?: number;
  fileLimit?: number;
}

export const getStructuralRewritePlanTool: IToolDefinition = {
  // Tool name intentionally uses "codemod" rather than "rewrite" — the
  // CLI ceremony tests forbid any MCP tool name containing the
  // substring "write" so a future read of the catalog can't mistake a
  // preview tool for a write surface. The plan is still read-only
  // here; apply ceremony happens via `shrk search-structural ... --apply`.
  name: 'get_structural_codemod_plan',
  description:
    'Preview a structural codemod as a per-file edit plan (`sharkcraft.structural-rewrite-plan/v1`). Read-only — apply ceremony stays on the CLI (`shrk search-structural ... --apply`). Useful for "what would this codemod do?" without touching disk.',
  cliCommand: 'search-structural',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'object' },
      recipe: { type: 'object' },
      files: { type: 'array', items: { type: 'string' } },
      perFileLimit: { type: 'number' },
      fileLimit: { type: 'number' },
    },
    required: ['pattern', 'recipe'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const pattern = args.pattern as StructuralPattern | undefined;
    const recipe = args.recipe as RewriteRecipe | undefined;
    if (!pattern || typeof pattern !== 'object' || !(pattern as { kind?: string }).kind) {
      return { isError: true, error: { code: 'invalid-input', message: 'pattern.kind is required' } };
    }
    if (!recipe || typeof recipe !== 'object' || !(recipe as { kind?: string }).kind) {
      return { isError: true, error: { code: 'invalid-input', message: 'recipe.kind is required' } };
    }
    const plan = planRewrite({
      projectRoot: ctx.inspection.projectRoot,
      pattern,
      recipe,
      ...(args.files ? { files: args.files } : {}),
      ...(typeof args.perFileLimit === 'number' ? { perFileLimit: clamp(args.perFileLimit, 1, 1000) } : {}),
      ...(typeof args.fileLimit === 'number' ? { fileLimit: clamp(args.fileLimit, 1, 50000) } : {}),
    });
    return { data: plan };
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
