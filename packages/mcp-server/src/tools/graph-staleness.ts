import { hasCallGraphReferences, type GraphQueryApi, type INode } from '@shrkcrft/graph';

/**
 * A note when a symbol's file language has no call-graph extraction (Go/Python/
 * Java/…) — only TS/JS build call/reference edges — so an empty caller/usage
 * result isn't read as "nothing calls it". Returns undefined for TS/JS.
 */
export function callGraphLanguageNote(api: GraphQueryApi, sym: INode): string | undefined {
  const file = sym.path ? api.findFile(sym.path) : undefined;
  const lang = file?.data?.['language'] as string | undefined;
  if (hasCallGraphReferences(lang)) return undefined;
  return `Call/reference edges are extracted for TS/JS only — \`${sym.label}\` is in a ${lang} file, so callers/usages are not tracked here (an empty result does NOT mean none).`;
}

export const GRAPH_STALE_HINT =
  'Result files changed since indexing — run `shrk graph index --changed` for fresh results.';

export interface IGraphStaleSurface {
  /** Result file paths deleted on disk — drop entries whose `path` is in this set. */
  deletedSet: ReadonlySet<string>;
  /** Spread into the tool `data` object; null when every result file is fresh. */
  field:
    | { stale: { modified: readonly string[]; deleted: readonly string[] }; staleHint: string }
    | null;
}

/**
 * Targeted, read-only staleness over a query's result file paths. The graph
 * MCP tools use it to DROP deleted result files and FLAG modified ones, so a
 * stale index never silently serves a wrong/dead answer for a file the agent
 * just edited. Cheap: stats only the handful of result files (mtime+size gate,
 * sha1 only on mismatch) — never a whole-tree walk.
 */
export function graphResultStaleness(
  api: GraphQueryApi,
  cwd: string,
  paths: ReadonlyArray<string | undefined>,
): IGraphStaleSurface {
  const rel = paths.filter((p): p is string => !!p);
  const stale = api.staleFilesAmong(cwd, rel);
  const has = stale.modified.length > 0 || stale.deleted.length > 0;
  return {
    deletedSet: new Set(stale.deleted),
    field: has
      ? { stale: { modified: stale.modified, deleted: stale.deleted }, staleHint: GRAPH_STALE_HINT }
      : null,
  };
}

/** Filter out result entries whose file path was deleted on disk. */
export function dropDeleted<T extends { id: string; path?: string }>(
  rows: readonly T[],
  deletedSet: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => !r.path || !deletedSet.has(r.path));
}
