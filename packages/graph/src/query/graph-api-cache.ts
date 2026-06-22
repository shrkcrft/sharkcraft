import { statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { GraphStore } from '../store/graph-store.ts';
import { GraphQueryApi } from './query-api.ts';

interface ICachedGraphApi {
  /** `<meta.json mtimeMs>:<size>` — changes whenever the store is rebuilt. */
  key: string;
  api: GraphQueryApi;
}

const CACHE = new Map<string, ICachedGraphApi>();
const MAX_ENTRIES = 4;

/**
 * Load the graph query API for a project, cached across calls keyed by the
 * store's `meta.json` mtime+size.
 *
 * The MCP server is long-lived and every graph tool used to re-read + re-parse
 * the ~12MB on-disk store and rebuild four in-memory indexes on EVERY request
 * (~30–165ms). The store only changes when the index is rebuilt
 * (`graph index` / `updateChanged` rewrite `meta.json`, bumping its mtime), so
 * keying the cache on that stat reloads only when it genuinely changed —
 * including when a SEPARATE process (a CLI `graph index`) rebuilt it. The query
 * API is read-only, so sharing one instance across calls is safe.
 *
 * Returns `null` when no index exists. NOTE: this caches the STORE, not
 * working-tree freshness — source-file edits are still detected per-query via
 * {@link GraphQueryApi.staleFilesAmong}; the two are orthogonal.
 */
export function loadGraphApiCached(projectRoot: string): GraphQueryApi | null {
  const metaPath = nodePath.join(projectRoot, '.sharkcraft', 'graph', 'meta.json');
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(metaPath);
  } catch {
    CACHE.delete(projectRoot);
    return null;
  }
  const key = `${Math.floor(st.mtimeMs)}:${st.size}`;
  const hit = CACHE.get(projectRoot);
  if (hit && hit.key === key) return hit.api;

  const store = new GraphStore(projectRoot);
  if (!store.exists()) {
    CACHE.delete(projectRoot);
    return null;
  }
  const api = new GraphQueryApi(store.loadSnapshot());
  if (!CACHE.has(projectRoot) && CACHE.size >= MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(projectRoot, { key, api });
  return api;
}

/** Drop all cached snapshots (tests / explicit invalidation). */
export function clearGraphApiCache(): void {
  CACHE.clear();
}
