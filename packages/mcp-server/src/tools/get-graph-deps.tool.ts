import { EdgeKind, GraphQueryApi, GraphStore } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk graph index';

interface IDepsInput {
  /** Required: workspace package name (e.g. `@shrkcrft/graph`). */
  package?: string;
}

/**
 * Read-only MCP mirror of `shrk graph deps`. Returns the workspace
 * package's outbound (`depends on`) and inbound (`depended on by`)
 * `package-depends-on` edges from the persisted code graph.
 *
 * Mirrors the safety contract: structured `graph-missing` error when
 * the index isn't built; `not-found` when no `package:<name>` node
 * exists.
 */
export const getGraphDepsTool: IToolDefinition = {
  name: 'get_graph_deps',
  description:
    'Return inbound + outbound `package-depends-on` edges for a workspace package. Read-only.',
  cliCommand: 'graph deps',
  inputSchema: {
    type: 'object',
    properties: {
      package: { type: 'string' },
    },
    required: ['package'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IDepsInput;
    const target = (args.package ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'package is required' },
      };
    }
    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: `Code-intelligence index is missing. Run '${NEXT}'.`,
          details: { nextCommand: NEXT },
        },
      };
    }
    const api = GraphQueryApi.fromStore(ctx.inspection.projectRoot);
    const pkgId = `package:${target}`;
    const pkgNode = api.neighbours(pkgId)?.node;
    if (!pkgNode) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No workspace package node "${target}" in the graph.`,
          details: { target },
        },
      };
    }
    const dependsOn = api
      .packageDeps(target)
      .map((n) => n.id.replace(/^package:/, ''))
      .sort();
    const dependedOnBy: string[] = [];
    for (const p of api.allPackages()) {
      const name = p.id.replace(/^package:/, '');
      if (name === target) continue;
      if (api.packageDeps(name).some((n) => n.id === pkgId)) dependedOnBy.push(name);
    }
    dependedOnBy.sort();
    void EdgeKind;
    return {
      data: {
        schema: 'sharkcraft.graph-deps/v1',
        package: target,
        dependsOn,
        dependedOnBy,
      },
    };
  },
};
