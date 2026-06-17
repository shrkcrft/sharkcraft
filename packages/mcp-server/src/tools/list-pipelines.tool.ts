import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listPipelinesTool: IToolDefinition = {
  name: 'list_pipelines',
  description: 'List available SharkCraft AI development pipelines (declarative agent workflows). Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const list = ctx.inspection.pipelineRegistry.list();
    const rows = list.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description,
      tags: p.tags ?? [],
      scope: p.scope ?? [],
      appliesWhen: p.appliesWhen ?? [],
      stepCount: p.steps.length,
    }));
    return { data: formatRows(rows, input) };
  },
};
