import { EdgeKind } from '../schema/edge-kind.ts';
import type { IEdge } from '../schema/edge.ts';

export interface IUnresolvedImportSummary {
  /** Total `unresolved:<spec>` ImportsFile edges. */
  unresolvedImportCount: number;
  /** Distinct file ids with at least one unresolved import. */
  filesWithUnresolvedImports: number;
  /** Up to `sampleLimit` distinct specifier strings. */
  unresolvedImportSamples: readonly string[];
}

const DEFAULT_SAMPLE_LIMIT = 10;

/**
 * Roll up unresolved imports from the indexer's edge list. The indexer
 * already emits edges targeting `unresolved:<spec>` when the resolver
 * fails (relative path doesn't exist, alias points nowhere, workspace
 * package not found). This helper counts them so the manifest can
 * carry a stable counter the doctor + dashboard read from.
 *
 * Pure function over the dedupe'd edge set; no I/O.
 */
export function summarizeUnresolvedImports(
  edges: readonly IEdge[],
  sampleLimit: number = DEFAULT_SAMPLE_LIMIT,
): IUnresolvedImportSummary {
  let unresolvedImportCount = 0;
  const fileSet = new Set<string>();
  const sampleSet = new Set<string>();
  for (const e of edges) {
    if (e.kind !== EdgeKind.ImportsFile) continue;
    if (!e.to.startsWith('unresolved:')) continue;
    unresolvedImportCount += 1;
    fileSet.add(e.from);
    if (sampleSet.size < sampleLimit) {
      sampleSet.add(e.to.slice('unresolved:'.length));
    }
  }
  return {
    unresolvedImportCount,
    filesWithUnresolvedImports: fileSet.size,
    unresolvedImportSamples: [...sampleSet].sort(),
  };
}
