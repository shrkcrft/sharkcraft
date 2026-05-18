import { exploreArea } from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const exploreAreaTool: IToolDefinition = {
  name: 'explore_area',
  description:
    'Explore a directory: area kind, key modules, related commands/MCP tools, tests, conventions, edit risks. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to project root (or absolute).' },
      topFiles: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const p = (input as { path: unknown }).path;
    if (typeof p !== 'string' || p.length === 0) {
      return { data: { error: 'path required' } };
    }
    const top = (input as { topFiles?: unknown }).topFiles;
    const pathConventions = ctx.inspection.pathService.list().map((pc) => ({
      id: pc.id,
      pattern:
        (pc.metadata as Readonly<Record<string, unknown>> | undefined)?.path as string | undefined,
    }));
    const report = exploreArea({
      inspection: ctx.inspection,
      path: p,
      pathConventions,
      ...(typeof top === 'number' && top > 0 ? { topFiles: top } : {}),
    });
    return { data: report };
  },
};
