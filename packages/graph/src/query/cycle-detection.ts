import type { IEdge } from '../schema/edge.ts';
import type { INode } from '../schema/node.ts';
import { EdgeKind } from '../schema/edge-kind.ts';

export interface ICycleSummary {
  /** Number of strongly-connected components of size ≥ 2. */
  cycleCount: number;
  /** Size of the largest SCC of size ≥ 2 (0 if no cycles). */
  largestCycleSize: number;
  /** Total number of file nodes participating in some cycle. */
  filesInCycles: number;
}

/**
 * A single import cycle. `nodeIds` are the participating `file:<path>`
 * node ids, in iteration order from Tarjan SCC (the entry node is at
 * index 0; the cycle is undirected from a presentation standpoint).
 * Renderers usually want to display `paths` instead — file ids are
 * stable but bear the `file:` prefix.
 */
export interface IFileCycle {
  /** Stable file node ids that form the cycle. */
  nodeIds: readonly string[];
  /** Project-relative file paths (filled when callers can resolve them). */
  paths?: readonly string[];
  /** Cycle size (== nodeIds.length). */
  size: number;
}

/**
 * Find every import cycle in the file-import directed graph. Returns
 * one entry per SCC of size ≥ 2. Iterative Tarjan SCC over the
 * `imports-file` subgraph; O(V+E) and stack-safe.
 *
 * `pathById` is optional — when supplied, the returned `paths` array
 * is populated so callers don't have to re-resolve file ids.
 */
export function findFileCycles(
  nodes: readonly INode[],
  edges: readonly IEdge[],
  pathById?: ReadonlyMap<string, string>,
): readonly IFileCycle[] {
  const adj = buildFileAdjacency(nodes, edges);
  const sccs = stronglyConnectedComponentsIterative(adj);
  const out: IFileCycle[] = [];
  for (const scc of sccs) {
    if (scc.length < 2) continue;
    const cycle: IFileCycle = {
      nodeIds: [...scc],
      size: scc.length,
    };
    if (pathById) {
      cycle.paths = scc.map((id) => pathById.get(id) ?? id.replace(/^file:/, ''));
    }
    out.push(cycle);
  }
  // Stable order: by size DESC, then by first id ASC. Makes "show me
  // the worst cycle first" deterministic across runs.
  out.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return (a.nodeIds[0] ?? '').localeCompare(b.nodeIds[0] ?? '');
  });
  return out;
}

/**
 * Roll-up over `findFileCycles` results. Kept for downstream callers
 * (the indexer, doctor) that only care about counts.
 */
export function summarizeCycles(
  nodes: readonly INode[],
  edges: readonly IEdge[],
): ICycleSummary {
  const cycles = findFileCycles(nodes, edges);
  let largestCycleSize = 0;
  let filesInCycles = 0;
  for (const c of cycles) {
    if (c.size > largestCycleSize) largestCycleSize = c.size;
    filesInCycles += c.size;
  }
  return {
    cycleCount: cycles.length,
    largestCycleSize,
    filesInCycles,
  };
}

function buildFileAdjacency(
  nodes: readonly INode[],
  edges: readonly IEdge[],
): Map<string, string[]> {
  const fileIds = new Set<string>();
  for (const n of nodes) {
    if (n.id.startsWith('file:')) fileIds.add(n.id);
  }
  const adj = new Map<string, string[]>();
  for (const id of fileIds) adj.set(id, []);
  for (const e of edges) {
    if (e.kind !== EdgeKind.ImportsFile) continue;
    if (!fileIds.has(e.from) || !fileIds.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
  }
  return adj;
}

/**
 * Iterative Tarjan's strongly connected components. Returns one array
 * per SCC; singletons are included so callers that care about all of
 * them (e.g. `IGraphQueryApi.cycles()` once that ships) can filter
 * themselves. Tarjan is single-pass O(V+E), and unlike the recursive
 * form this version doesn't blow the stack on long import chains.
 */
function stronglyConnectedComponentsIterative(
  adj: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const nodeIds = [...adj.keys()];
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let index = 0;

  type Frame = { v: string; iter: number };
  for (const start of nodeIds) {
    if (indices.has(start)) continue;
    const callStack: Frame[] = [{ v: start, iter: 0 }];
    indices.set(start, index);
    lowlinks.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);

    while (callStack.length > 0) {
      const top = callStack[callStack.length - 1]!;
      const successors = adj.get(top.v) ?? [];
      if (top.iter < successors.length) {
        const w = successors[top.iter]!;
        top.iter += 1;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlinks.set(w, index);
          index += 1;
          stack.push(w);
          onStack.add(w);
          callStack.push({ v: w, iter: 0 });
        } else if (onStack.has(w)) {
          lowlinks.set(top.v, Math.min(lowlinks.get(top.v)!, indices.get(w)!));
        }
      } else {
        if (lowlinks.get(top.v) === indices.get(top.v)) {
          const scc: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === top.v) break;
          }
          result.push(scc);
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          lowlinks.set(
            parent.v,
            Math.min(lowlinks.get(parent.v)!, lowlinks.get(top.v)!),
          );
        }
      }
    }
  }
  return result;
}
