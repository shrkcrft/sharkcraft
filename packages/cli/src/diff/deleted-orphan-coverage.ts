import type { IVerdictCoverage } from '@shrkcrft/core';
import type { IDeletedOrphanScan } from './deleted-orphans.ts';

/** How many unexamined labels the coverage carries (the verdict line shows 5). */
const LABEL_CAP = 20;

/** How many files-changed-since-the-index the reason names before summarising. */
const STALE_NAMES_IN_REASON = 3;

const UNINDEXED_REASON = 'not in the code-graph index, so their importers were never checked';

/**
 * What an orphan scan EXAMINED against what the delete asked it to — the one
 * coverage authority for `check orphans` and the `finish` orphans sub-gate.
 *
 * "Who still imports the deleted code?" has two sides, and the code-graph
 * index must be current on both for a clean answer to mean anything:
 *
 *   - the DELETED side: a deleted source file the index does not know (the
 *     index predates it, or was rebuilt after the delete) had its importers
 *     never checked — expected, not examined;
 *   - the IMPORTER side: a file added or edited since the index was built may
 *     import the deleted code, and the index never read its current imports.
 *     While any such file exists, NO deleted file's importer set is complete,
 *     so every deleted file in scope is unexamined and the reason names the
 *     files the index never read (`scan.indexDivergence`, measured by the one
 *     freshness authority, `detectGraphFreshness`).
 *
 * Defining the unit as "indexed deleted files", or ignoring the importer side,
 * would make either gap disappear by construction — the clean-over-a-stale-
 * index verdict this closes.
 *
 * Only files the graph would index are in scope (`indexableDeleted`, the
 * graph's `isGraphIndexablePath`), so deleting a README or a `dist/*.js` next
 * to a `.ts` still reads clean. Nothing deleted, or nothing deleted that the
 * graph indexes, is `expected: 0` — "nothing to examine" — which the caller may
 * accept explicitly with `--allow-empty`; a stale index is irrelevant there
 * (there is no deleted code for anything to import).
 */
export function deletedOrphanCoverage(scan: IDeletedOrphanScan): IVerdictCoverage {
  const unit = 'deleted code files';
  const scopeLabel = scan.ref === 'STAGED' ? 'staged' : `vs ${scan.ref}`;
  if (scan.deleted.length === 0) {
    return { unit, expected: 0, examined: 0, reason: `nothing deleted (${scopeLabel})` };
  }
  const resolved = scan.report?.resolvedDeleted ?? [];
  const resolvedSet = new Set(resolved);
  const indexable = new Set(scan.indexableDeleted ?? scan.deleted);
  const unindexed = (scan.report?.unresolvedDeleted ?? []).filter(
    (p) => indexable.has(p) && !resolvedSet.has(p),
  );
  const expected = resolved.length + unindexed.length;
  if (expected === 0) {
    return {
      unit,
      expected: 0,
      examined: 0,
      reason: `${scan.deleted.length} file(s) deleted (${scopeLabel}), none of them source the code graph indexes`,
    };
  }
  const stale = staleIndexReason(scan);
  if (stale !== undefined) {
    const inScope = [...resolved, ...unindexed];
    return {
      unit,
      expected,
      examined: 0,
      unexamined: inScope.slice(0, LABEL_CAP),
      unexaminedTotal: inScope.length,
      reason: unindexed.length > 0 ? `not in the code-graph index, or ${stale}` : stale,
    };
  }
  return {
    unit,
    expected,
    examined: resolved.length,
    ...(unindexed.length > 0
      ? {
          unexamined: unindexed.slice(0, LABEL_CAP),
          unexaminedTotal: unindexed.length,
          reason: UNINDEXED_REASON,
        }
      : {}),
  };
}

/**
 * Why the importer side is unexamined, or `undefined` when the index is current
 * for every surviving file. Reads as the tail of `…, K <reason>: <files>`.
 */
function staleIndexReason(scan: IDeletedOrphanScan): string | undefined {
  const divergence = scan.indexDivergence;
  if (divergence === undefined) return undefined;
  if (!divergence.measured) return 'checked against an index whose freshness could not be measured';
  const changed = divergence.changed;
  // The package half of the freshness authority: a package entry that changed
  // since the index (and that the delete does not explain) means a bare
  // `import … from '<pkg>'` was never re-resolved — the same stale input.
  const packages = divergence.packagesChanged ?? [];
  if (changed.length === 0 && packages.length === 0) return undefined;
  const parts: string[] = [];
  if (changed.length > 0) {
    const shown = changed.slice(0, STALE_NAMES_IN_REASON).join(', ');
    const more = changed.length > STALE_NAMES_IN_REASON ? `, +${changed.length - STALE_NAMES_IN_REASON} more` : '';
    parts.push(`checked against a stale index that never read ${changed.length} file(s) changed since it was built (${shown}${more})`);
  }
  if (packages.length > 0) {
    const shown = packages.slice(0, STALE_NAMES_IN_REASON).join(', ');
    const more = packages.length > STALE_NAMES_IN_REASON ? `, +${packages.length - STALE_NAMES_IN_REASON} more` : '';
    parts.push(
      `${changed.length > 0 ? 'whose' : 'checked against a stale index whose'} package entry changed since it was built (${shown}${more}), so imports through it were never re-resolved`,
    );
  }
  return parts.join(', and ');
}
