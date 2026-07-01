import type { IDeletedOrphanReport } from '@shrkcrft/impact-engine';
import { collectChangedPaths } from './collect-changed-paths.ts';

/**
 * Why the scan could not produce an orphan report (so callers pick an exit
 * code / message): the diff was unavailable (no resolvable ref, git error) or
 * the code-graph store is missing.
 */
export type DeletedOrphanScanFailure = 'diff-unavailable' | 'graph-missing';

/** Result of {@link computeDeletedOrphans}. */
export interface IDeletedOrphanScan {
  /** True when the diff resolved (and, when anything was deleted, the graph too). */
  readonly ok: boolean;
  /** What was diffed: `'STAGED'` for `--staged`, otherwise the resolved ref. */
  readonly ref: string;
  /** Deleted files read from the diff (empty list is a valid, clean result). */
  readonly deleted: readonly string[];
  /**
   * The alias-resolved orphan report. Present iff `ok` AND something was
   * deleted — when `deleted` is empty the scan short-circuits clean without
   * loading the graph, so there is no report (and none is needed).
   */
  readonly report?: IDeletedOrphanReport;
  /** Why the scan failed. Present iff not `ok`. */
  readonly reason?: DeletedOrphanScanFailure;
  /** Human-readable failure detail. */
  readonly error?: string;
}

/**
 * Diff-driven reverse-closure: read the files DELETED in the changeset (vs
 * `since`, or the staged index when `staged`), then query the code-graph
 * snapshot for surviving files that still import them or reference a symbol
 * they declared (alias-resolved, incl. barrel re-exports). The shared core
 * behind `impact --deleted`, `check orphans`, and the composite `finish` gate.
 *
 * Never throws: a bad diff → `{ reason: 'diff-unavailable' }`, a missing index
 * → `{ reason: 'graph-missing' }`. Graph + engine are imported lazily so a
 * command that never hits the orphan path doesn't pay to load them.
 */
export async function computeDeletedOrphans(
  cwd: string,
  opts: { since?: string; staged?: boolean },
): Promise<IDeletedOrphanScan> {
  const changed = collectChangedPaths({
    cwd,
    ...(opts.since ? { ref: opts.since } : {}),
    ...(opts.staged ? { staged: true } : {}),
  });
  if (!changed.isAvailable) {
    return {
      ok: false,
      ref: changed.ref,
      deleted: [],
      reason: 'diff-unavailable',
      ...(changed.error ? { error: changed.error } : {}),
    };
  }

  // Nothing deleted → clean by definition; don't pay to load the graph (and
  // don't fail when no index exists — there is nothing to check).
  if (changed.deleted.length === 0) {
    return { ok: true, ref: changed.ref, deleted: [] };
  }

  const { GraphStore, GraphQueryApi } = await import('@shrkcrft/graph');
  if (!new GraphStore(cwd).exists()) {
    return {
      ok: false,
      ref: changed.ref,
      deleted: changed.deleted,
      reason: 'graph-missing',
      error: 'code-graph store missing — run `shrk graph index` first.',
    };
  }
  const { findDeletedOrphans } = await import('@shrkcrft/impact-engine');
  const report = findDeletedOrphans(GraphQueryApi.fromStore(cwd), changed.deleted);
  return { ok: true, ref: changed.ref, deleted: changed.deleted, report };
}
