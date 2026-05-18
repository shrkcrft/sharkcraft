import type { IToolDefinition } from '../server/tool-definition.ts';

export const listPipelinesTool: IToolDefinition = {
  name: 'list_pipelines',
  description: 'List available SharkCraft AI development pipelines (declarative agent workflows).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const list = ctx.inspection.pipelineRegistry.list();
    return {
      data: list.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        tags: p.tags ?? [],
        scope: p.scope ?? [],
        appliesWhen: p.appliesWhen ?? [],
        stepCount: p.steps.length,
      })),
    };
  },
};
