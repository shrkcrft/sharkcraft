import type { IPackageEntryDivergence } from '@shrkcrft/graph';
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
  /**
   * The deleted paths the code graph INDEXES (the graph's own authority,
   * `isGraphIndexablePath` — extension AND skipped directories). A deleted
   * README or `dist/x.js` is outside the orphan check's scope; a deleted `.ts`
   * the index does not know is a gap in it. Present iff {@link report} is.
   * Read by `deletedOrphanCoverage`.
   */
  readonly indexableDeleted?: readonly string[];
  /**
   * How the code-graph index diverges from the tree on disk, measured by the
   * one freshness authority (`detectGraphFreshness`). `changed` = indexable
   * files NEW or MODIFIED since the index was built, the deleted set excluded:
   * each is a possible importer of the deleted code whose current imports the
   * index never read, so a clean orphan answer over them proves nothing.
   * `measured: false` = the divergence could not be measured (also never a
   * pass). Present iff {@link report} is. Read by `deletedOrphanCoverage`.
   */
  readonly indexDivergence?: {
    readonly measured: boolean;
    readonly changed: readonly string[];
    /**
     * Workspace packages whose entry diverged since the index was built, that
     * the delete does NOT explain (the one freshness authority's
     * `packageDivergences`). Package entries are an index input no source
     * fingerprint covers: after a package.json edit a bare `import … from
     * '<pkg>'` resolves somewhere else, and the stale index still resolves it
     * to the old entry — so an importer of the deleted code through it is
     * invisible. A divergence whose indexed entry FILE is itself in the delete
     * (dir unchanged) is explained: the orphan query covers imports of it.
     */
    readonly packagesChanged?: readonly string[];
  };
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

  const { GraphStore, GraphQueryApi, detectGraphFreshness, isGraphIndexablePath } = await import(
    '@shrkcrft/graph'
  );
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
  // The importer side of the question: the index answers "who imports the
  // deleted code?" only for files whose CURRENT imports it has read. A file
  // added or edited since the index was built may import the deleted code and
  // the query would never see it — the stale-input shape CLAUDE.md says must be
  // loud-skipped, measured by the one freshness authority.
  const freshness = detectGraphFreshness(cwd);
  const deletedSet = new Set(changed.deleted);
  const changedSinceIndex = [...freshness.added, ...freshness.modified]
    .filter((p) => !deletedSet.has(p))
    .sort((a, b) => a.localeCompare(b));
  // The package half of the same authority (`graphFreshnessBehind` counts it):
  // a package entry that diverged since the index, unless the delete itself
  // explains it. Reading added+modified alone called an index "current" that
  // `graph status` calls stale (round 11 review).
  const divergences: readonly IPackageEntryDivergence[] =
    freshness.packageDivergences ?? freshness.packagesChanged.map((name): IPackageEntryDivergence => ({ name }));
  const packagesChanged = divergences
    .filter((d) => !deleteExplainsDivergence(d, deletedSet))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    ref: changed.ref,
    deleted: changed.deleted,
    report,
    indexableDeleted: changed.deleted.filter((p) => isGraphIndexablePath(p)),
    indexDivergence: {
      measured: freshness.hasIndex,
      changed: changedSinceIndex,
      ...(packagesChanged.length > 0 ? { packagesChanged } : {}),
    },
  };
}

/**
 * A package-entry divergence the delete EXPLAINS: the indexed entry file is
 * part of the delete and the package did not move. Imports of that entry are
 * exactly what the orphan query checks, so the index is not stale about it.
 */
function deleteExplainsDivergence(
  d: { readonly storedEntry?: string | null; readonly storedDir?: string; readonly currentDir?: string },
  deleted: ReadonlySet<string>,
): boolean {
  return (
    typeof d.storedEntry === 'string' &&
    deleted.has(d.storedEntry) &&
    (d.currentDir === undefined || d.currentDir === d.storedDir)
  );
}
