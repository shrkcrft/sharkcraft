import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatRows } from '../server/columnar-format.ts';

export const listBoundaryRulesTool: IToolDefinition = {
  name: 'list_boundary_rules',
  description:
    'List every configured boundary rule (local + pack-contributed). Returns id, title, severity, from/forbidden patterns, source. Pass `format:"table"` for a token-efficient columnar payload.',
  inputSchema: {
    type: 'object',
    properties: { ...FORMAT_INPUT_PROPERTY },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const rows = ctx.inspection.boundaryRegistry.list().map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      severity: r.severity ?? 'error',
      from: r.from,
      forbiddenImports: r.forbiddenImports ?? [],
      allowedImports: r.allowedImports ?? [],
      tags: r.tags ?? [],
      source: ctx.inspection.boundarySources.get(r.id) ?? null,
    }));
    return { data: formatRows(rows, input) };
  },
};
