import { prepareQualityGateRun, runQualityGates, settleQualityGateReport } from '@shrkcrft/quality-gates';
import type { IToolDefinition } from '../server/tool-definition.ts';

interface IInput {
  sinceRef?: string;
  failOn?: readonly ('high' | 'critical')[];
  disable?: readonly string[];
}

export const getQualityGateTool: IToolDefinition = {
  name: 'get_quality_gate',
  description:
    'Read-only: run the code-intelligence quality-gate aggregator (graph freshness, architecture, impact since `main`, the project\'s wiring + policy rules, knowledge symbol refs) and return the unified report with the SAME settled `exitCode` / `verdict` / `shortfalls` `shrk gate` exits on — a gate that examined only part of its scope is `not-verified`, never `pass`. The CI / pre-merge hook for AI-agent-authored changes.',
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
  async handler(input, ctx) {
    const args = input as IInput;
    // THE gate-run assembly `shrk gate` uses (`prepareQualityGateRun`): the
    // project's wiring / policy rules, the plane scan scope, the knowledge
    // inspection. It used to pass the impact options only.
    const prepared = await prepareQualityGateRun({
      cwd: ctx.inspection.projectRoot,
      ...(args.sinceRef ? { sinceRef: args.sinceRef } : {}),
      ...(args.failOn ? { failOn: args.failOn } : {}),
      ...(args.disable ? { disable: args.disable } : {}),
      inspection: ctx.inspection,
    });
    const report = runQualityGates(prepared.options);
    // THE settle `shrk gate` exits on — never `overall` read raw.
    const settled = settleQualityGateReport(report);
    return {
      data: {
        ...report,
        exitCode: settled.exit,
        verdict: settled.verdict,
        shortfalls: settled.shortfalls,
        accepted: settled.accepted,
        ...(prepared.planeDiagnostics.length > 0 ? { planeDiagnostics: prepared.planeDiagnostics } : {}),
      },
    };
  },
};
