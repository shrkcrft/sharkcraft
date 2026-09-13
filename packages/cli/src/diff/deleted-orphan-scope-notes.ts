import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IDeletedOrphanScan } from './deleted-orphans.ts';

/**
 * What an orphan answer must say about its own scope, next to the verdict line.
 * Shared by `check orphans` and `impact --deleted`, which answer the same
 * question ("who still imports the deleted code?") from the same scan and so
 * must explain a partial answer the same way.
 *
 *   - `index` — the `index` kv value, set when indexed code was deleted and the
 *     importer side is stale (the index never read files changed since it was
 *     built) or its freshness could not be measured;
 *   - `lead`  — the NOT VERIFIED lead, set when the coverage left deleted code
 *     unexamined: why, and the remedy (index the PRE-delete tree, re-run
 *     `rerun`).
 *
 * The coverage itself comes from `deletedOrphanCoverage`, the one authority for
 * what the scan examined; this only words it.
 */
export function deletedOrphanScopeNotes(
  scan: IDeletedOrphanScan,
  coverage: IVerdictCoverage,
  rerun: string,
): { readonly index?: string; readonly lead?: string } {
  const divergence = scan.indexDivergence;
  const packages = divergence?.packagesChanged ?? [];
  const staleIndex =
    coverage.expected > 0 &&
    divergence !== undefined &&
    (!divergence.measured || divergence.changed.length > 0 || packages.length > 0);
  const packageNote =
    packages.length > 0
      ? `package entry changed (${packages.slice(0, 3).join(', ')}${packages.length > 3 ? `, +${packages.length - 3} more` : ''})`
      : undefined;
  const index =
    staleIndex && divergence !== undefined
      ? divergence.measured
        ? `stale — ${[
            divergence.changed.length > 0 ? `${divergence.changed.length} file(s) changed since it was built` : undefined,
            packageNote,
          ]
            .filter((s): s is string => s !== undefined)
            .join('; ')}`
        : 'freshness could not be measured'
      : undefined;
  const staleLead =
    divergence !== undefined && divergence.measured && divergence.changed.length === 0 && packages.length > 0
      ? `The code-graph index predates a package entry change (${packages.slice(0, 3).join(', ')}), so an import of the deleted code through it was never re-resolved.\n`
      : 'The code-graph index predates files changed since it was built, so an import of the deleted code in them was never checked.\n';
  const lead =
    coverage.expected > 0 && coverage.examined < coverage.expected
      ? (staleIndex
          ? staleLead
          : 'Deleted source files the code-graph index does not know were never checked for importers.\n') +
        `Index the PRE-delete tree (\`shrk graph index\`), then re-run \`${rerun}\`.`
      : undefined;
  return {
    ...(index !== undefined ? { index } : {}),
    ...(lead !== undefined ? { lead } : {}),
  };
}
