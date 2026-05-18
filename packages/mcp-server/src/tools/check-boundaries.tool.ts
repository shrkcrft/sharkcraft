import { evaluateBoundaries, scanImports, summarizeImports } from '@shrkcrft/boundaries';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const checkBoundariesTool: IToolDefinition = {
  name: 'check_boundaries',
  description:
    'Scan the project imports and evaluate every configured boundary rule. Returns violations + counts + import-graph summary. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: 'Optional: evaluate only one rule by id.' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const ruleId = (input as { ruleId?: unknown }).ruleId;
    const rules = ctx.inspection.boundaryRegistry.list();
    if (rules.length === 0) {
      return {
        data: {
          rulesEvaluated: 0,
          violations: [],
          counts: { error: 0, warning: 0, info: 0 },
          note: 'no boundary rules configured',
        },
      };
    }
    const scan = scanImports({ projectRoot: ctx.inspection.projectRoot });
    const result = evaluateBoundaries(
      scan,
      rules,
      typeof ruleId === 'string' ? { onlyRuleId: ruleId } : {},
    );
    return {
      data: {
        rulesEvaluated: result.rulesEvaluated,
        edgesEvaluated: result.edgesEvaluated,
        counts: result.counts,
        violations: result.violations,
        importGraph: summarizeImports(scan),
      },
    };
  },
};
