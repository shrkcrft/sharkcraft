import { detectGraphFreshness, GraphStore } from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';

const NEXT = 'shrk graph index';
const STALE_HINT = `Code-intelligence index is missing or stale. Run '${NEXT}' to build it.`;

/**
 * Read-only status for the on-disk code graph. Returns
 * { state: 'fresh' | 'stale' | 'corrupt' | 'missing' } and counters.
 * `corrupt` (store self-integrity) and `stale` (files changed on disk since
 * indexing) are orthogonal — a store can be digest-valid yet stale — so
 * precedence is corrupt > stale > fresh. On 'missing', `isError` +
 * `nextCommand` direct the caller to refresh.
 */
export const getGraphStatusTool: IToolDefinition = {
  name: 'get_graph_status',
  description:
    'Read-only status of the SharkCraft code-intelligence graph: state (fresh/stale/corrupt/missing), file/node/edge counts, and how many files changed/added/deleted since indexing. Returns nextCommand when stale or missing so the agent knows to refresh before trusting graph answers.',
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
    const fresh = detectGraphFreshness(ctx.inspection.projectRoot);
    const behind = fresh.modified.length + fresh.added.length + fresh.deleted.length;
    const state = !verify.ok ? 'corrupt' : behind > 0 ? 'stale' : 'fresh';
    return {
      data: {
        schema: snap.manifest.schema,
        state,
        digestOk: verify.ok,
        fileCount: snap.manifest.filesIndexed,
        nodeCount: snap.nodes.size,
        edgeCount: snap.edges.size,
        nodesByKind: snap.manifest.nodesByKind,
        edgesByKind: snap.manifest.edgesByKind,
        workspacePackages: snap.manifest.workspacePackages,
        lastIndexedAt: snap.manifest.lastIndexedAt,
        lastIndexDurationMs: snap.manifest.lastIndexDurationMs,
        modifiedSinceIndex: fresh.modified.length,
        newSinceIndex: fresh.added.length,
        deletedSinceIndex: fresh.deleted.length,
        ...(behind > 0 ? { nextCommand: 'shrk graph index --changed' } : {}),
        ...(verify.ok ? {} : { expectedDigest: verify.expected, actualDigest: verify.actual }),
      },
    };
  },
};
