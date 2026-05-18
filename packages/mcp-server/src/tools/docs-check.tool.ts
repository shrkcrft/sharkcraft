import { buildDocsCheck, buildExamplesCheck } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getDocsCheckTool: IToolDefinition = {
  name: 'get_docs_check',
  description: 'Verify docs/ and README content. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false },
  handler(_input, ctx) {
    return { data: buildDocsCheck(ctx.cwd) };
  },
};

export const getExamplesCheckTool: IToolDefinition = {
  name: 'get_examples_check',
  description: 'Verify examples/ tree. Read-only.',
  inputSchema: { type: 'object', additionalProperties: false },
  handler(_input, ctx) {
    return { data: buildExamplesCheck(ctx.cwd) };
  },
};
