import { analyzeGraphImpact, type IGraphImpactInput } from '@shrkcrft/impact-engine';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  files?: readonly string[];
  symbol?: string;
  gitref?: string;
  maxDepth?: number;
  limit?: number;
}

export const getGraphImpactAnalysisTool: IToolDefinition = {
  name: 'get_graph_impact_analysis',
  description:
    'Rich graph-backed change analysis (schema sharkcraft.graph-impact-analysis/v3). Inputs: file list OR symbol OR git ref. Returns affected symbols/files/packages/rules/templates/tests/risk + recommended validation commands. Read-only.',
  cliCommand: 'graph impact',
  inputSchema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' } },
      symbol: { type: 'string' },
      gitref: { type: 'string' },
      maxDepth: { type: 'number' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    let resolved: IGraphImpactInput | undefined;
    if (args.files && args.files.length > 0) resolved = { kind: 'files', files: args.files };
    else if (args.symbol) resolved = { kind: 'symbol', symbolId: args.symbol };
    else if (args.gitref) resolved = { kind: 'gitref', ref: args.gitref };
    if (!resolved) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'One of `files`, `symbol`, or `gitref` is required.' },
      };
    }
    const analysis = analyzeGraphImpact(resolved, {
      projectRoot: ctx.inspection.projectRoot,
      limit: clamp(args.limit ?? 200, 1, 2000),
      maxDepth: clamp(args.maxDepth ?? 5, 1, 10),
    });
    return { data: analysis };
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
