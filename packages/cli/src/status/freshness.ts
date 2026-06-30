import { readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Source-mtime freshness — a small shared CLI helper.
 *
 * Several `… status` commands (`framework status`, `context status`) need to
 * answer the same question: "is this stored artefact stale relative to the
 * source tree it was built from?" They all walk the workspace for the newest
 * source-file mtime and compare it to a stored build timestamp. This module
 * is the single home for that walk so the commands stay byte-identical.
 *
 * NOTE: this is deliberately CLI-local and distinct from
 * `@shrkcrft/graph`'s `detectGraphFreshness` — that one models the graph
 * store's own freshness and graph sits BELOW cli in the layer order, so it
 * cannot be reused here.
 */

export const FRESHNESS_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.git', '.sharkcraft',
  '.next', '.cache', '.tmp-pack', 'out', 'target',
]);
export const FRESHNESS_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.cs', '.py', '.go', '.rs', '.kt', '.swift',
]);

export interface IStatusFreshness {
  state: 'fresh' | 'stale' | 'unknown';
  lastBuiltAt: string | null;
  lastChangedAt: string | null;
  behindMs: number;
}

/** Newest source-file mtime (ms) under `root`, ignoring build/output dirs. 0
 *  when nothing matched. */
export function newestSourceMtimeMs(root: string): number {
  let newest = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (FRESHNESS_SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = nodePath.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!FRESHNESS_SOURCE_EXTS.has(nodePath.extname(full).toLowerCase())) continue;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  return newest;
}

/** Compare a stored build timestamp to the newest source mtime in `scope`.
 *  `stale` when a source file is newer than the build; `unknown` when the
 *  build timestamp can't be parsed. */
export function computeMtimeFreshness(scope: string, builtAtIso: string | undefined | null): IStatusFreshness {
  const newestMs = newestSourceMtimeMs(scope);
  const lastChangedAt = newestMs > 0 ? new Date(newestMs).toISOString() : null;
  const builtMs = builtAtIso ? Date.parse(builtAtIso) : NaN;
  if (!Number.isFinite(builtMs)) {
    return { state: 'unknown', lastBuiltAt: builtAtIso ?? null, lastChangedAt, behindMs: 0 };
  }
  const behindMs = newestMs > builtMs ? Math.round(newestMs - builtMs) : 0;
  return {
    state: behindMs > 0 ? 'stale' : 'fresh',
    lastBuiltAt: builtAtIso ?? null,
    lastChangedAt,
    behindMs,
  };
}
