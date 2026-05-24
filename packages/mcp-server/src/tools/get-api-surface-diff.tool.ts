import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  diffApiSurfaces,
  extractApiSurface,
  type IApiSurface,
} from '@shrkcrft/api-surface-diff';
import { GraphStore } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk graph index';

interface IInput {
  baselinePath?: string;
  baseline?: IApiSurface;
  packages?: readonly string[];
}

export const getApiSurfaceDiffTool: IToolDefinition = {
  name: 'get_api_surface_diff',
  description:
    'Read-only: compare the current code-graph public-API surface to a baseline. Provide `baselinePath` (file system path to a previously captured `IApiSurface`) OR `baseline` (inline). Optional `packages` filter restricts both sides to those workspace packages.',
  cliCommand: 'api-diff',
  inputSchema: {
    type: 'object',
    properties: {
      baselinePath: { type: 'string' },
      baseline: { type: 'object' },
      packages: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IInput;
    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: "code-graph store missing",
          details: { nextCommand: NEXT },
        },
      };
    }
    let baseline: IApiSurface | undefined = args.baseline;
    if (!baseline && args.baselinePath) {
      const abs = nodePath.isAbsolute(args.baselinePath)
        ? args.baselinePath
        : nodePath.resolve(ctx.inspection.projectRoot, args.baselinePath);
      try {
        baseline = JSON.parse(readFileSync(abs, 'utf8'));
      } catch (e) {
        return {
          isError: true,
          error: { code: 'invalid-input', message: `baseline read failed: ${(e as Error).message}` },
        };
      }
    }
    if (!baseline) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'baseline or baselinePath is required' },
      };
    }
    const snap = store.loadSnapshot();
    const current = extractApiSurface(snap, {
      ...(args.packages && args.packages.length > 0 ? { packageFilter: args.packages } : {}),
    });
    const diff = diffApiSurfaces(baseline, current);
    return { data: diff };
  },
};
