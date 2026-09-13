import {
  loadAgentContractTests,
  runAgentContractTest,
  warmReferenceRegistries,
} from '@shrkcrft/inspector';
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
    // The same registry `shrk test agent` resolves against (MCP ≡ CLI). No
    // command index here: an unsurfaced `expectedCommands` entry is reported
    // NOT VERIFIED (verdict `not-verified`), never a false failure.
    await warmReferenceRegistries(ctx.inspection);
    return { data: runAgentContractTest(ctx.inspection, test) };
  },
};
