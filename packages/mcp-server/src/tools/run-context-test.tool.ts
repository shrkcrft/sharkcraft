import {
  loadContextTests,
  runContextTest,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const listContextTestsTool: IToolDefinition = {
  name: 'list_context_tests',
  description: 'List configured context regression tests (local + pack-contributed).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const tests = await loadContextTests(ctx.inspection);
    return { data: tests };
  },
};

export const runContextTestTool: IToolDefinition = {
  name: 'run_context_test',
  description:
    'Run one configured context regression test by id. Returns whether the expected entries were included/excluded in the retrieved context.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const id = String((input as { id?: unknown }).id ?? '');
    const tests = await loadContextTests(ctx.inspection);
    const test = tests.find((t) => t.id === id);
    if (!test) return { isError: true, text: `No context test with id "${id}".` };
    return { data: runContextTest(ctx.inspection, test) };
  },
};
