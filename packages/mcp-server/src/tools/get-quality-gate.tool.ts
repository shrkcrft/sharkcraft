import { runQualityGates } from '@shrkcrft/quality-gates';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  sinceRef?: string;
  failOn?: readonly ('high' | 'critical')[];
  disable?: readonly string[];
}

export const getQualityGateTool: IToolDefinition = {
  name: 'get_quality_gate',
  description:
    'Read-only: run the code-intelligence quality-gate aggregator (graph freshness, architecture, impact since `main`) and return the unified pass/fail report. The CI / pre-merge hook for AI-agent-authored changes.',
  cliCommand: 'gate',
  inputSchema: {
    type: 'object',
    properties: {
      sinceRef: { type: 'string' },
      failOn: { type: 'array', items: { type: 'string', enum: ['high', 'critical'] } },
      disable: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const report = runQualityGates({
      projectRoot: ctx.inspection.projectRoot,
      impact: {
        ...(args.sinceRef ? { sinceRef: args.sinceRef } : {}),
        ...(args.failOn ? { failOn: args.failOn } : {}),
      },
      ...(args.disable ? { disable: args.disable } : {}),
    });
    return { data: report };
  },
};
