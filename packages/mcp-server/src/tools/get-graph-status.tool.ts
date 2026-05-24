import { GraphStore } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk graph index';
const STALE_HINT = `Code-intelligence index is missing or stale. Run '${NEXT}' to build it.`;

/**
 * Read-only status for the on-disk code graph. Returns
 * { state: 'fresh' | 'corrupt' | 'missing' } and counters.
 * On 'missing', `isError` + `error.details.nextCommand` direct the
 * caller (CLI or human) to refresh.
 */
export const getGraphStatusTool: IToolDefinition = {
  name: 'get_graph_status',
  description:
    'Read-only status of the SharkCraft code-intelligence graph: file/node/edge counts, schema, last indexed time, digest verification. Returns nextCommand when missing.',
  cliCommand: 'graph status',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler(_input, ctx) {
    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: STALE_HINT,
          details: { nextCommand: NEXT, state: 'missing' },
        },
      };
    }
    const verify = store.verifyDigest();
    const snap = store.loadSnapshot();
    return {
      data: {
        schema: snap.manifest.schema,
        state: verify.ok ? 'fresh' : 'corrupt',
        digestOk: verify.ok,
        fileCount: snap.manifest.filesIndexed,
        nodeCount: snap.nodes.size,
        edgeCount: snap.edges.size,
        nodesByKind: snap.manifest.nodesByKind,
        edgesByKind: snap.manifest.edgesByKind,
        workspacePackages: snap.manifest.workspacePackages,
        lastIndexedAt: snap.manifest.lastIndexedAt,
        lastIndexDurationMs: snap.manifest.lastIndexDurationMs,
        ...(verify.ok ? {} : { expectedDigest: verify.expected, actualDigest: verify.actual }),
      },
    };
  },
};
