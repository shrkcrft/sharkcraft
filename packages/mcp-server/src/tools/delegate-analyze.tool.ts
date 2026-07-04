import { compressMarkdown } from '@shrkcrft/compress';
import { loadProjectConfig } from '@shrkcrft/config';
import { resolveDelegateCatalogForProject, runGroundingReport } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

const READONLY_NOTE =
  'Read-only. This tool returns ONLY the deterministic grounding report — it never runs a model and never writes. The local-model judgment layer runs on the CLI (`shrk delegate analyze`), on-machine, never over MCP.';

interface IDelegateAnalyzeInput {
  task?: string;
  recipe?: string;
  /** Path to a saved plan (required for a `plan-simulation`-grounded recipe). */
  plan?: string;
}

export const delegateAnalyzeTool: IToolDefinition = {
  name: 'delegate_analyze',
  description:
    'Get the deterministic GROUNDING for a read-only `analysis` delegate recipe (e.g. arch/risk review), plus the exact `shrk delegate analyze` next command. Returns the ground-truth report the local model would reason over — never runs a model, never writes. The judgment pass runs on the CLI. Needs a `delegation` block with a `mode: "analysis"` recipe in sharkcraft.config.ts.',
  cliCommand: 'delegate',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      recipe: { type: 'string' },
      plan: { type: 'string' },
    },
    required: ['task', 'recipe'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const args = input as IDelegateAnalyzeInput;
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
    const catalog = await resolveDelegateCatalogForProject(loaded.value.config, loaded.value.projectRoot);
    const recipe = catalog.find((r) => r.id === recipeId);
    if (!recipe) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `unknown recipe "${recipeId}". Available: ${catalog.map((r) => r.id).join(', ') || '(none)'}`,
          details: { available: catalog.map((r) => r.id) },
        },
      };
    }
    if (recipe.mode !== 'analysis') {
      return {
        isError: true,
        error: {
          code: 'not-analysis',
          message: `recipe "${recipeId}" is a patch recipe — use delegate_task / \`shrk delegate run\`.`,
        },
      };
    }
    if (!recipe.groundedOn || !recipe.groundingBound) {
      return {
        isError: true,
        error: {
          code: 'ungrounded',
          message: `recipe "${recipeId}" has no known groundedOn report — nothing to ground the analysis on.`,
        },
      };
    }
    // `delegate-failure` grounding only exists inside the delegate retry loop
    // (it needs a failed attempt); it can't be produced standalone over MCP.
    if (recipe.groundedOn === 'delegate-failure') {
      return {
        isError: true,
        error: {
          code: 'needs-failure-context',
          message: `recipe "${recipeId}" grounds on a delegate failure — it only runs inside \`shrk delegate run --assisted-retry\`, not standalone.`,
        },
      };
    }
    const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
    if (recipe.groundedOn === 'plan-simulation' && !plan) {
      return {
        isError: true,
        error: {
          code: 'needs-plan',
          message: `recipe "${recipeId}" grounds on a plan simulation — pass the saved plan path as \`plan\`.`,
        },
      };
    }

    // Run ONLY the deterministic grounding report (no model, no write).
    const facts = await runGroundingReport(recipe.groundedOn, task, ctx.inspection, { ...(plan ? { planPath: plan } : {}) });
    const groundingMarkdown = [
      `# Delegate analysis grounding: ${recipe.title ?? recipe.id}`,
      '',
      `**Task:** ${task}`,
      `**Grounded on:** \`${recipe.groundedOn}\` (deterministic, no model)`,
      '',
      '## Ground truth',
      '',
      facts.summary,
      '',
      '## How to add the judgment layer',
      '',
      'Run the `next` command on the CLI: a local model adds judgment on top of this',
      'ground truth, and every finding citing an entity absent from it is flagged',
      '`unverified`. The model runs on-machine — never over MCP, which never runs a model.',
    ].join('\n');
    const compressed = compressMarkdown(
      groundingMarkdown,
      ctx.ccrStore ? { store: ctx.ccrStore, query: task } : { query: task },
    );
    return {
      data: {
        schema: 'sharkcraft.delegate-analyze/v1',
        recipeId: recipe.id,
        title: recipe.title ?? recipe.id,
        mode: 'analysis',
        task,
        groundedOn: recipe.groundedOn,
        entityCount: facts.entities.length,
        grounding: compressed.compressed,
        ...(compressed.ccrKey ? { ccrKey: compressed.ccrKey } : {}),
        next: `shrk delegate analyze "${task}" --recipe ${recipe.id}`,
        note: READONLY_NOTE,
      },
    };
  },
};
