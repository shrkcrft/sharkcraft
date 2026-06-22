import { compressMarkdown } from '@shrkcrft/compress';
import { loadProjectConfig, type IDelegateRecipe } from '@shrkcrft/config';
import type { IToolDefinition } from '../server/tool-definition.ts';

const READONLY_NOTE =
  'Read-only. The CLI is the only write path. The worker may emit ONLY the allowed ops and touch ONLY the guardrail globs; the edit is verified deterministically and auto-reverted on failure — so it lands only if it passes the recipe verification.';

interface IDelegateTaskInput {
  task?: string;
  recipe?: string;
}

export const delegateTaskTool: IToolDefinition = {
  name: 'delegate_task',
  description:
    'Get a compact brief for delegating a MECHANICAL, deterministically-verifiable edit to the local-LLM worker (read-only). Returns the recipe fence — allowed ops, guardrail globs, verification — and the exact `shrk delegate run` next command. Hand the grunt edit to the local worker instead of spending your own tokens reading the whole file and writing the edit. Never writes; needs a `delegation` block in sharkcraft.config.ts.',
  cliCommand: 'delegate',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      recipe: { type: 'string' },
    },
    required: ['task', 'recipe'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const args = input as IDelegateTaskInput;
    const task = (args.task ?? '').trim();
    const recipeId = (args.recipe ?? '').trim();
    if (!task || !recipeId) {
      return { isError: true, error: { code: 'invalid-input', message: 'task and recipe are required' } };
    }
    const loaded = await loadProjectConfig(ctx.inspection.projectRoot);
    if (!loaded.ok) {
      return { isError: true, error: { code: 'config-error', message: loaded.error.message } };
    }
    const delegation = loaded.value.config.delegation;
    if (!delegation || delegation.enabled === false) {
      return {
        isError: true,
        error: {
          code: 'not-enabled',
          message: 'delegation is not enabled in sharkcraft.config.ts',
          details: { nextCommand: 'add a delegation { recipes: [...] } block to sharkcraft.config.ts' },
        },
      };
    }
    const recipes = delegation.recipes ?? [];
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `unknown recipe "${recipeId}". Available: ${recipes.map((r) => r.id).join(', ') || '(none)'}`,
          details: { available: recipes.map((r) => r.id) },
        },
      };
    }
    const provider = recipe.provider ?? delegation.provider ?? 'auto';
    const briefMarkdown = buildBriefMarkdown(task, recipe, provider);
    // Compress the brief body (CCR-reversible when the server store is present).
    // Small briefs pass through unchanged via the net-loss guard.
    const compressed = compressMarkdown(
      briefMarkdown,
      ctx.ccrStore ? { store: ctx.ccrStore, query: task } : { query: task },
    );
    return {
      data: {
        schema: 'sharkcraft.delegate-task/v1',
        recipeId: recipe.id,
        title: recipe.title ?? recipe.id,
        task,
        allowedOps: recipe.allowedOps,
        guardrailGlobs: recipe.guardrailGlobs,
        verificationIds: recipe.verificationIds,
        provider,
        riskCeiling: recipe.riskCeiling ?? null,
        brief: compressed.compressed,
        ...(compressed.ccrKey ? { ccrKey: compressed.ccrKey } : {}),
        next: `shrk delegate run "${task}" --recipe ${recipe.id} --apply`,
        note: READONLY_NOTE,
      },
    };
  },
};

function buildBriefMarkdown(task: string, recipe: IDelegateRecipe, provider: string): string {
  return [
    `# Delegate brief: ${recipe.title ?? recipe.id}`,
    '',
    `**Task:** ${task}`,
    '',
    `**Recipe:** \`${recipe.id}\``,
    `**Allowed ops:** ${recipe.allowedOps.join(', ')}`,
    `**Guardrail globs (the worker may ONLY touch files matching these):** ${recipe.guardrailGlobs.join(', ')}`,
    `**Verification (must pass or the edit is reverted):** ${recipe.verificationIds.join(', ') || '(none)'}`,
    `**Provider:** ${provider}${recipe.model ? ` (${recipe.model})` : ''}`,
    '',
    '## How to delegate',
    '',
    'The CLI is the only write path. Run the `next` command: the local worker generates the edit,',
    'the deterministic engine verifies it against the recipe verification, and auto-reverts on failure —',
    'so the edit lands only if it is correct. You pay for this brief and the compact result, not for',
    'reading the whole file or writing the edit yourself.',
  ].join('\n');
}
