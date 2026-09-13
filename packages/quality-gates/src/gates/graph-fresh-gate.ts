import {
  detectGraphFreshness,
  GraphStore,
  graphFreshnessBehind,
  graphFreshnessCoverage,
  graphFreshnessRemedy,
  type IGraphFreshness,
} from '@shrkcrft/graph';
import type { IGateResult } from '../schema/quality-gate.ts';

/**
 * Check whether the code-graph store exists, its manifest digest matches the
 * on-disk JSONL fingerprints, AND it is current with the working tree.
 * Catches: missing index; tampered / partial store; schema mismatch; an index
 * behind the working tree.
 *
 * Digest-valid is not current (round 11 review R11-GAP-2): a store can be
 * intact yet stale. Freshness is decided by THE authority —
 * `detectGraphFreshness`, the one `graph status`, doctor, code-intel and MCP
 * read (the runner passes the measurement it already made) — so this gate can
 * never call "fresh" an index `graph status` calls stale. A stale index is a
 * `warn` carrying the shared coverage record, which settles `shrk gate` and MCP
 * `get_quality_gate` to NOT VERIFIED (2).
 */
export function graphFreshGate(projectRoot: string, freshness?: IGraphFreshness): IGateResult {
  const start = Date.now();
  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    return {
      id: 'graph-fresh',
      label: 'Code graph indexed',
      status: 'fail',
      message: 'Code-graph store missing.',
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const verify = store.verifyDigest();
  if (!verify.ok) {
    return {
      id: 'graph-fresh',
      label: 'Code graph indexed',
      status: 'fail',
      message: 'Code-graph digest mismatch — store may be tampered or partial.',
      details: { expected: verify.expected, actual: verify.actual },
      nextCommands: ['shrk graph index'],
      durationMs: Date.now() - start,
    };
  }
  const fresh = freshness ?? detectGraphFreshness(projectRoot);
  const coverage = graphFreshnessCoverage(fresh, 'graph-fresh');
  if (coverage) {
    return {
      id: 'graph-fresh',
      label: 'Code graph indexed',
      status: 'warn',
      message: fresh.hasIndex
        ? `Code-graph index is stale — ${fresh.modified.length} modified, ${fresh.added.length} new, ${fresh.deleted.length} deleted, ${fresh.packagesChanged.length} package(s) changed since it was built (NOT VERIFIED).`
        : 'Code-graph index freshness could not be measured against the working tree (NOT VERIFIED).',
      details: {
        behind: graphFreshnessBehind(fresh),
        modified: fresh.modified.length,
        added: fresh.added.length,
        deleted: fresh.deleted.length,
        packagesChanged: fresh.packagesChanged,
      },
      coverage: [coverage],
      nextCommands: [graphFreshnessRemedy(fresh)],
      durationMs: Date.now() - start,
    };
  }
  return {
    id: 'graph-fresh',
    label: 'Code graph indexed',
    status: 'pass',
    message: 'Code-graph index is fresh.',
    durationMs: Date.now() - start,
  };
}
