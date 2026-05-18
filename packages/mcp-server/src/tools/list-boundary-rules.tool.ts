import type { IToolDefinition } from '../server/tool-definition.ts';

export const listBoundaryRulesTool: IToolDefinition = {
  name: 'list_boundary_rules',
  description:
    'List every configured boundary rule (local + pack-contributed). Returns id, title, severity, from/forbidden patterns, source.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_input, ctx) {
    return {
      data: ctx.inspection.boundaryRegistry.list().map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        severity: r.severity ?? 'error',
        from: r.from,
        forbiddenImports: r.forbiddenImports ?? [],
        allowedImports: r.allowedImports ?? [],
        tags: r.tags ?? [],
        source: ctx.inspection.boundarySources.get(r.id) ?? null,
      })),
    };
  },
};
