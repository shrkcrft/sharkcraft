import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listPathConventionsTool: IToolDefinition = {
  name: 'list_path_conventions',
  description: 'List known path conventions. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const paths = ctx.inspection.pathService.list();
    const rows = paths.map((p) => ({
      id: p.id,
      title: p.title,
      path: (p.metadata?.path as string | undefined) ?? '',
      priority: p.priority,
      tags: p.tags,
      scope: p.scope,
      appliesWhen: p.appliesWhen,
      description: (p.metadata?.description as string | undefined) ?? p.summary,
    }));
    return { data: formatRows(rows, input) };
  },
};
