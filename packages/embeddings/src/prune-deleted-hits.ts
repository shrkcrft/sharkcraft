import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISemanticHit } from './semantic-index.ts';

/**
 * Drop semantic hits whose file is gone from disk — a stale embedding index must
 * never suggest a deleted file (the freshness-in-the-moment guarantee for
 * semantic retrieval, mirroring the code graph's deleted-result prune). Score
 * order is preserved; when `k` is given the live result is capped at `k` (so an
 * over-fetch can backfill the holes left by deleted files).
 */
export function pruneDeletedHits(
  hits: readonly ISemanticHit[],
  cwd: string,
  k?: number,
): { hits: ISemanticHit[]; prunedDeleted: number } {
  const live: ISemanticHit[] = [];
  let prunedDeleted = 0;
  for (const h of hits) {
    const abs = nodePath.isAbsolute(h.path) ? h.path : nodePath.join(cwd, h.path);
    if (existsSync(abs)) {
      if (k === undefined || live.length < k) live.push(h);
    } else {
      prunedDeleted += 1;
    }
  }
  return { hits: live, prunedDeleted };
}
