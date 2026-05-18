import { loadAgentContractTests, runAgentContractTest } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listAgentTestsTool: IToolDefinition = {
  name: 'list_agent_tests',
  description: 'List configured agent contract tests (local + pack-contributed).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const tests = await loadAgentContractTests(ctx.inspection);
    return { data: tests };
  },
};

export const runAgentTestTool: IToolDefinition = {
  name: 'run_agent_test',
  description:
    'Run one configured agent contract test by id. Verifies the task packet contains the expected pipeline / templates / rules / forbidden actions / verification commands.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const tests = await loadAgentContractTests(ctx.inspection);
    const test = tests.find((t) => t.id === id);
    if (!test) return { isError: true, text: `No agent contract test with id "${id}".` };
    return { data: runAgentContractTest(ctx.inspection, test) };
  },
};
