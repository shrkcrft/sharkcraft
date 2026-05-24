import { FrameworkQueryApi } from '@shrkcrft/framework-scanners';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk framework index';

interface IInput {
  framework?: string;
  subtype?: string;
  file?: string;
  limit?: number;
  routes?: boolean;
}

export const getFrameworkEntitiesTool: IToolDefinition = {
  name: 'get_framework_entities',
  description:
    'Read-only: list framework entities discovered by the extractors (NestJS controllers/modules/providers/routes, React components/hook usages). Filters: framework, subtype, file. Pass `routes: true` for the NestJS route table.',
  cliCommand: 'framework list',
  inputSchema: {
    type: 'object',
    properties: {
      framework: { type: 'string' },
      subtype: { type: 'string' },
      file: { type: 'string' },
      limit: { type: 'number' },
      routes: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const missing = FrameworkQueryApi.missingDescription(ctx.inspection.projectRoot);
    if (missing) {
      return {
        isError: true,
        error: { code: 'framework-missing', message: missing, details: { nextCommand: NEXT } },
      };
    }
    const api = FrameworkQueryApi.fromStore(ctx.inspection.projectRoot);
    if (args.routes) {
      const routes = api.routes();
      return {
        data: {
          schema: 'sharkcraft.framework-routes/v1',
          total: routes.length,
          routes,
        },
      };
    }
    const limit = clamp(args.limit ?? 100, 1, 2000);
    const entities = api.list({
      ...(args.framework ? { framework: args.framework } : {}),
      ...(args.subtype ? { subtype: args.subtype } : {}),
      ...(args.file ? { file: args.file } : {}),
      limit,
    });
    return {
      data: {
        schema: 'sharkcraft.framework-list/v1',
        filters: {
          framework: args.framework ?? null,
          subtype: args.subtype ?? null,
          file: args.file ?? null,
        },
        total: entities.length,
        entities: entities.map((n) => ({
          id: n.id,
          label: n.label,
          path: n.path,
          framework: n.data?.['framework'] ?? null,
          subtype: n.data?.['subtype'] ?? null,
          data: n.data,
        })),
      },
    };
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
