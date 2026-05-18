import type { IToolDefinition } from '../server/tool-definition.ts';

export const listPathConventionsTool: IToolDefinition = {
  name: 'list_path_conventions',
  description: 'List known path conventions.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    const paths = ctx.inspection.pathService.list();
    return {
      data: paths.map((p) => ({
        id: p.id,
        title: p.title,
        path: (p.metadata?.path as string | undefined) ?? '',
        priority: p.priority,
        tags: p.tags,
        scope: p.scope,
        appliesWhen: p.appliesWhen,
        description: (p.metadata?.description as string | undefined) ?? p.summary,
      })),
    };
  },
};
