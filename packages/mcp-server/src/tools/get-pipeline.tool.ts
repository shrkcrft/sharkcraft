import type { IToolDefinition } from '../server/tool-definition.ts';
import { formatPipelineFull } from '@shrkcrft/pipelines';

export const getPipelineTool: IToolDefinition = {
  name: 'get_pipeline',
  description: 'Get one pipeline by id with all steps + inputs + notes.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const p = ctx.inspection.pipelineRegistry.get(String(input.id ?? ''));
    if (!p) return { isError: true, text: `No pipeline with id "${input.id}".` };
    return { data: p, text: formatPipelineFull(p) };
  },
};
